import * as vscode from 'vscode';
import path = require("path");
import { DGDConnection } from './DGDConnection';
import { Main } from './Main';
import { Lpc, ObjectStatus, CodeResult } from './Lpc';


// https://code.visualstudio.com/api/references/vscode-api#TreeDataProvider
export class ClonesProvider implements vscode.TreeDataProvider<Clone> 
{
	private _onDidChangeTreeData: vscode.EventEmitter<Clone | undefined> = new vscode.EventEmitter<Clone | undefined>();
	readonly onDidChangeTreeData: vscode.Event<Clone | undefined> = this._onDidChangeTreeData.event;
	private clones = new Map<string, Clone[]>();
	private master: Clone = new Clone("?", 0, 0);
	public selectedItem: Clone = null;


	constructor(private conn: DGDConnection)
	{
	}
	

	refresh(): void
	{
		this.selectedItem = null;
		this._onDidChangeTreeData.fire();
	}


	public get masterObject(): Clone
	{
		return this.master;
	}


	public onActiveEditorChanged(ed: vscode.TextEditor): void
	{
		if(!ed || ed.document.languageId !== "c") {
			this.master = null;
			this.refresh();
			return;
		}

		this.updateMasterAndClonesInfo(ed);
	}


	private updateMasterAndClonesInfo(ed: vscode.TextEditor): void
	{
		let obName = this.conn.getObjectName(ed.document.fileName);
		let obClones : Clone[] = [];

		if(Main.setting("cloneIdsCallEnabled")) {
			let lpc: string = Lpc.getCloneIdsSnippet(obName);

			this.conn.sendThen(Lpc.code(lpc), (cr: CodeResult) => {
				if(!cr.success) {
					console.error("error getting clones: " + JSON.stringify(cr));
					this.master = new Clone(obName, 0, 0);
					this.refresh();
					return;
				}

				if(cr.result === null) {
					this.conn.message("-Probably- unable to check for clones (result was null). To get rid of this message, add the ability to get clone IDs in your DGD library, see 'cloneIdsCall' setting. Or disable it by unchecking 'cloneIdsCallEnabled').");
					return;
				}

				if(cr.result !== null) {
					for(let i = 0; i < cr.result.length; i++) {
						obClones.push(new Clone(obName, cr.result[i], 0));
					}

					let lpcClonesQuery: string = Lpc.getClonesToStringSnippet(obName, cr.result);

					this.conn.sendThen(Lpc.code(lpcClonesQuery), (cr: CodeResult) => {
						if(!cr.success) {
							console.warn("clonesToString failed: " + JSON.stringify(cr));
							return;
						}

						for(let i = 0; i < cr.result.length; i++) {
							obClones[i].comment = cr.result[i];
						}
					});
				}

				this.clones.set(vscode.window.activeTextEditor.document.fileName, obClones);
				this.refresh();
			});
		}

		// set tooltip and to_string() for master/inheritable/lwo (if compiled)
		this.master = new Clone(obName, 0, this.clones.size);
		let objectStatusQuery: string = Lpc.getObjectStatusSnippet(obName);

		this.conn.sendThen(Lpc.code(objectStatusQuery), (cr: CodeResult) => {
			if(!cr.success) {
				console.error("Error getting object status: " + JSON.stringify(cr));
				this.refresh();
				return;
			}

			if(cr.result === null) {
				this.master.comment = "Not Compiled";
				this.refresh();
				return;
			} else if(this.master === null) {
				return;
			} else {
				this.master.comment = cr.result[ObjectStatus.ToString];
			}

			this.master.tip = 
				  `Last compiled: ${Lpc.unixTimeToDateTime(cr.result[ObjectStatus.CompileTime])}\n`
				+ `Program size: ${cr.result[ObjectStatus.ProgramSize]}\n`
				+ `Data size: ${cr.result[ObjectStatus.DataSize]}\n`
				+ `Sectors: ${cr.result[ObjectStatus.Sectors]}\n`
				+ `Call outs: ${cr.result[ObjectStatus.CallOuts]}\n`
				+ `Index: ${cr.result[ObjectStatus.Index]}\n`
				+ `Undefined: ${cr.result[ObjectStatus.Undefined]}\n`
				/* gone in DGD 1.6.5
				+ `Inherited: ${cr.result[ObjectStatus.Inherited]}\n`
				+ `Instantiated: ${cr.result[ObjectStatus.Instantiated]}\n`
				*/
				+ ``
			;
			this.refresh();
		});

	}


	getTreeItem(element: Clone): vscode.TreeItem 
	{
		return element;
	}


	getParent?(element: Clone): vscode.ProviderResult<Clone>
	{
		// A parent is always the 'master obejct' (only two levels in the tree)
		if(element.cloneId === 0) {
			return null;
		}
		return this.master;
    }


	getChildren(element?: Clone): Thenable<Clone[]> {
		if(element === undefined) {
			return Promise.resolve(
				[ this.master ]
			);
		}

		if(element.cloneId === 0) {
			return Promise.resolve(
				this.clones.get(vscode.window.activeTextEditor.document.fileName)
			);
		}

		return Promise.resolve( [] );
	}

}


export class Clone extends vscode.TreeItem
{
	public comment: string;
	public tip: string;


	constructor(public objectName: string, public cloneId: number, public numClones: number) 
	{
		super(
			(cloneId > 0 
				? "#" + cloneId.toString() 
				: path.basename(objectName)
			), 
			(cloneId > 0 
				? vscode.TreeItemCollapsibleState.None 
				: vscode.TreeItemCollapsibleState.Expanded
			)
		);
		this.comment = "";
		this.tip = "";

		this.command = {
			command: "cloneView.selectNode",
			title: "Select Object",
			arguments: [ this ]
		};
	}

	get cloneName(): string
	{
		return this.cloneId === 0 ? this.objectName : (this.objectName + "#" + this.cloneId);
	}

	hasClones(): boolean
	{
		return this.numClones > 0;
	}


	get tooltip(): string 
	{
		if(this.cloneId === 0) {
			return this.tip;
		}
		return ((this.comment !== null && this.comment !== undefined && this.comment.length > 0) ? this.comment : this.objectName) + "\nSelect this clone to call a function it it.";
	}


	get description(): string 
	{
		if(this.comment !== null && this.comment !== undefined && this.comment.length > 0) {
			return this.comment;
		} else if(this.cloneId === 0) {
			return "Master";
		} else {
			return this.objectName;
		}
	}

	contextValue = 'DGDObject';
}
