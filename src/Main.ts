// Some notes to self on developing this extension
// -----------------------------------------------
//	- F5 : compile and start new VS code instance running the extension
//	- Ctrl+shift+p : show exposed commands
//	- Ctrl+r to rerun an editor in debug (the one running the extension)
//	- If you get funky errors saying that module 'vscode' cannot be found, 
//	  check the .vscode folder of the project, there should be 4 files there:
//	  extensions.json, launch.json, settings.json and tasks.json
//	- Default keybindings:
//	  https://code.visualstudio.com/shortcuts/keyboard-shortcuts-windows.pdf
//	- On Windows, start DGD with:
//	  i/TreeGame/dgd> bin/dgd klib/kernel.dgd > dgd.log 2>&1
//	- To get name of built-in commands, best is to open keybindings configuration, 
//	  then click "edit json" link. At the bottom there you find most (all?) 
//	  commands.
//	- Publishing and packaging:
//		$ cd <extensiondir>
//		$ vsce package
//	  https://code.visualstudio.com/api/working-with-extensions/publishing-extension
//	- ctrl+r a debugged window for a long long time will create some rather
//	  weird results here and there. Additionally, the Debug Console will get
//	  REALLY sluggish. Solution: Kill the debugee and restart with f5.
//	- On Windows, extensions sit in: C:\Users\<username>\.vscode\extensions
//	- For quick and dirty regex testing I use: https://regex101.com/
//	- Sometime down the line:
//	  let workspaceFolder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Pick Workspace Folder' })


import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { DGDConnection } from "./DGDConnection";
import { Clone, ClonesProvider } from "./ClonesProvider";
import { Lpc } from './Lpc';
import { ScopeHandler } from './ScopeHandler';
import fs = require('fs');


export class Main
{
	private conn: DGDConnection;
	private clonesTreeView: vscode.TreeView<Clone>;
	private logTerminal: vscode.Terminal;

	public static clonesProvider: ClonesProvider;
	public static scopeHandler: ScopeHandler;
	public static requireCodeAssistProxyVersion: number = 11;


	constructor(private context: vscode.ExtensionContext)
	{
		let disposable : vscode.Disposable;

		console.log("Configuration:\n" + JSON.stringify(vscode.workspace.getConfiguration('DGDCode'), null, 4));

		if(!fs.existsSync(Main.setting("libraryPath"))) {
			vscode.window.showErrorMessage(
				`Action needed! First time you run DGD Code Assist, some configuration is required. ` +
				`This dialog will stop appearing once the setting Library Path points to a valid directory. You will likely ` +
				`want to tweak more things, though. The settings view should have opened automatically.\n\n` +
				`Click "Extensions", then "DGD Code".\n\n` +
				`Here you should set libraryPath (the important one) and your login details.\n\n` +
				`When done, please restart VSCode...`
			);
			console.log("NOTE: Not starting extension because we're not configured...");
			vscode.commands.executeCommand('workbench.action.openSettings');
			return;
		}

		// Connect to DGD
		this.conn = new DGDConnection(
			Main.setting("libraryPath"),
			Main.setting("host"),
			Main.setting("port"), 
			Main.setting("user"), 
			Main.setting("userPassword")
		);

		// Forcefully change the C/CPP settings to be better suited for LPC
		if(Main.setting("forceCExtensionConf")) {
			// https://github.com/Microsoft/vscode/issues/15350
			// https://github.com/Microsoft/vscode/issues/14500
			// https://github.com/Microsoft/vscode/issues/37041 (important)
			let config = vscode.workspace.getConfiguration("C_Cpp", Uri.file(Main.setting("libraryPath")));
			config.update("autocomplete", "Disabled");
			config.update("errorSquiggles", "Disabled");
			config.update("intelliSenseEngineFallback", "Disabled");
			config.update("intelliSenseEngine", "Tag Parser");
			console.log("Tweaked C/C++ configuration for LPC.");
		}

		// Open a terminal, then follow dgd.log
		if(Main.setting("dgdLogFollow")) {
			// https://github.com/Microsoft/vscode-extension-samples/blob/master/terminal-sample/src/extension.ts
			this.logTerminal = vscode.window.createTerminal("DGD Log");
			// XXX: assumes GNU tail in a bash-ish env for now. Get-Content for Powershell, I believe.
			this.logTerminal.sendText("tail -f " + Main.setting("dgdLog"));
		}

		// Set up scope handler for calling current scope
		Main.scopeHandler = new ScopeHandler(this.conn);

		// Fetch document symbols on startup
		if(Main.activeEditor() !== null) {
			Main.scopeHandler.fetchDocumentSymbols(Main.activeEditor().document);
		}

		// Open klib dir on startup
		if(Main.setting("openFolderOnStartup")) {
			let success = vscode.commands.executeCommand('vscode.openFolder', Uri.file(this.conn.libPath));
		}

		// Command for arbitrary code
		disposable = vscode.commands.registerCommand('dgdcode.code', () => {
			Lpc.arbitraryCode(this.conn);
		});
		context.subscriptions.push(disposable);
	
		// Command for forcing a reconnect to DGD
		disposable = vscode.commands.registerCommand('dgdcode.reconnect', () => {
			this.conn.close();
			// TODO: Test. This is likely not good enough. Socket needs to be shut down before we try this.
			this.conn.reconnect();
		});
		context.subscriptions.push(disposable);
	
		// Command for calling current scope
		disposable = vscode.commands.registerCommand('dgdcode.callCurrentScope', () => {
			Main.scopeHandler.callCurrentScope(Main.activeEditor());
		});
		context.subscriptions.push(disposable);
	
		// Get document symbols on editor switch
		disposable = vscode.window.onDidChangeActiveTextEditor((ed: vscode.TextEditor) => {
			if(ed === undefined) {
				return;
			}
			Main.scopeHandler.fetchDocumentSymbols(ed.document);
		});
		context.subscriptions.push(disposable);
	


		// Command for compile object (in explorer)
		disposable = vscode.commands.registerCommand('dgdcode.compile', (uri : Uri) => {
			Lpc.compileObject(this.conn, uri.fsPath);
		});
		context.subscriptions.push(disposable);

		// Command for destruct object (in explorer)
		disposable = vscode.commands.registerCommand('dgdcode.destruct', (uri : Uri) => {
			Lpc.destructObject(this.conn, this.conn.getObjectName(uri.fsPath));
		});
		context.subscriptions.push(disposable);

		// Command for status object (in explorer)
		disposable = vscode.commands.registerCommand('dgdcode.status', (uri : Uri) => {
			Lpc.outputStatusObject(this.conn, this.conn.getObjectName(uri.fsPath));
		});
		context.subscriptions.push(disposable);



		// Command for compile object (in editor)
		disposable = vscode.commands.registerCommand('dgdcode.compileCurrent', (arg: any) => {
			Lpc.compileObject(this.conn, Main.activeEditor().document.uri.fsPath);
		});
		context.subscriptions.push(disposable);

		// Command for destruct master object (in editor)
		disposable = vscode.commands.registerCommand('dgdcode.destructCurrent', (arg: any) => {
			Lpc.destructObject(this.conn, this.conn.getObjectName(Main.activeEditor().document.uri.fsPath));
		});
		context.subscriptions.push(disposable);

		// Command for status master object (in editor)
		disposable = vscode.commands.registerCommand('dgdcode.statusCurrent', () => {
			Lpc.outputStatusObject(this.conn, this.conn.getObjectName(Main.activeEditor().document.uri.fsPath));
		});
		context.subscriptions.push(disposable);



		// Command for compile clone (in Object Instances view)
		disposable = vscode.commands.registerCommand('dgdcode.compileInstance', (clone: Clone) => {
			console.log("compile");
			Lpc.compileObject(this.conn, clone.objectName, true);
		});
		context.subscriptions.push(disposable);

		// Command for destructing object (in Object Instances view)
		disposable = vscode.commands.registerCommand('dgdcode.destructInstance', (arg: any) => {
			console.log("destruct");
			Lpc.destructObject(this.conn, Main.activeEditor().document.uri.fsPath, arg);
		});
		context.subscriptions.push(disposable);
	
		// Command for getting object status (in Object Instances view)
		disposable = vscode.commands.registerCommand('dgdcode.statusInstance', (arg: any) => {
			console.log("status");
			Lpc.outputStatusObject(this.conn, Main.activeEditor().document.uri.fsPath, arg);
		});
		context.subscriptions.push(disposable);



		// Recompile on save
		disposable = vscode.workspace.onDidSaveTextDocument((e: vscode.TextDocument) => {
			if(!Main.setting("recompileOnSave") || e.languageId !== "c") {
				return;
			}
			Lpc.compileObject(this.conn, e.fileName);
		});
		context.subscriptions.push(disposable);
	
		// Handling of master objects and clones in separate view
		Main.clonesProvider = new ClonesProvider(this.conn);

		this.clonesTreeView = vscode.window.createTreeView('cloneView', {
			treeDataProvider: Main.clonesProvider 
		});
		context.subscriptions.push(this.clonesTreeView);

		disposable = vscode.commands.registerCommand("cloneView.selectNode", (item: Clone) => {
			Main.clonesProvider.selectedItem = item;
		});
		context.subscriptions.push(disposable);

		disposable = vscode.window.onDidChangeActiveTextEditor((ed: vscode.TextEditor) =>
			Main.clonesProvider.onActiveEditorChanged(ed)
		);
		context.subscriptions.push(disposable);
	}


	public destructor()
	{
		if(this.logTerminal !== null) {
			this.logTerminal.dispose();
		}
		this.conn.destructor();
	}


	public static activeEditor(): vscode.TextEditor
	{
		if(vscode && vscode.window && vscode.window.activeTextEditor) {
			return vscode.window.activeTextEditor;
		}
		return null;
	}


	// https://github.com/Microsoft/vscode-extension-samples/blob/master/configuration-sample/src/extension.ts
	public static setting(name: string): any
	{
		if(vscode.workspace.workspaceFolders === undefined || vscode.workspace.workspaceFolders.length < 1) {
			vscode.window.showInformationMessage(`There is no workspace open for DGD Code Assist to work with.`);
			throw new URIError("No workspace");
		}

		let rsrc = vscode.workspace.workspaceFolders[0].uri;
		let val: any = vscode.workspace.getConfiguration('DGDCode').get(`${name}`);
		return val;
	}
}
