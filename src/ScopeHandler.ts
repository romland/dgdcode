import * as vscode from 'vscode';
import { Lpc, CodeResult } from './Lpc';
import { DGDConnection } from './DGDConnection';
import { Main } from './Main';


export class ScopeHandler
{
	private symbols: vscode.DocumentSymbol[] = [];
	private conn: DGDConnection;


	constructor(_conn: DGDConnection)
	{
		this.conn = _conn;
	}


	public async fetchDocumentSymbols(doc: vscode.TextDocument)
	{
		this.symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
	}

	public callCurrentScope(ed: vscode.TextEditor): void
	{
		this.fetchDocumentSymbols(ed.document).then(() => {
			this.callCurrentScopeReally(ed);
		});
	}

	private callCurrentScopeReally(ed: vscode.TextEditor): void
	{
		if(ed === null) {
			console.warn("callCurrentScopeReally(): no current editor");
			return;
		}

		let scope = this.getCurrentScope(ed);
		let obName = this.conn.getObjectName(ed.document.fileName);
		let funcSignature = scope.split("(");
		let funcName = funcSignature[0];

		if(Main.clonesProvider.selectedItem !== null) {
			let cloneName = Main.clonesProvider.selectedItem.cloneName;

			if(!cloneName.startsWith(obName)) {
				console.error("Current editor had: " + obName + ", selected clone was: " + cloneName);
				this.conn.message("Error: Inconsistency between selected clone and opened file. Will not execute function.");
				return;
			}
			obName = cloneName;
		} else {
			// oh, just call the master object by default -- nothing here
		}

		let callArgs = Lpc.stringToCallArgs(funcSignature[1].substr(0, funcSignature[1].length - 1));

		let c = this.conn;

		let resultHandler = () => {

			// if val is undefined, input was cancelled
			for(let i = 0; i < callArgs.length; i++) {
				if(callArgs[i].val === undefined) {
					console.error("Input cancelled");
					return;
				}
			}

			let lpc = Lpc.getCallSnippet(obName, funcName, callArgs);
			let code = Lpc.code(lpc);

			// Show what code we executed
			c.message(lpc, true);

			c.sendThen(code, function(cr: CodeResult) {
				if(cr.success) {
					c.message(Lpc.prettify(cr.result));
				} else {
					c.message(cr.error);
				}
			});
		};

		if(callArgs.length > 0) {
			Lpc.requestCallArgs(funcName, callArgs).then(() => {
				resultHandler();
			});
		} else {
			resultHandler();
		}
	}


	public getCurrentScope(ed: vscode.TextEditor): string
	{
		if(this.symbols === undefined) {
			console.log("Can't get scope. No symbol table yet!");
			return "";
		}

		let pos = ed.selection.start;
		let symbol: vscode.DocumentSymbol = null;

		for(let i = this.symbols.length - 1; i >= 0; i--) {
			if(pos.line >= this.symbols[i].range.start.line) {
				symbol = this.symbols[i];
				break;
			}
		}
	
		if(symbol === null) {
			return "";
		}

		// TODO: Improve. Look for ) or { as indication for end. A method signature could span over 10 lines.
		let argsRange: vscode.Range = new vscode.Range(symbol.range.end, new vscode.Position(symbol.range.end.line+10, 0));
		let args = ed.document.getText(argsRange);
		args = "(" + args.substr(1, args.length).split(")")[0] + ")";

		return symbol.name.split("(")[0] + args;
	}
}