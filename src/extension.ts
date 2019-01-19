import * as vscode from 'vscode';
import { Main } from './Main';


let main: Main;

export function activate(context: vscode.ExtensionContext) 
{
	main = new Main(context);
}


export function deactivate() 
{
	main.destructor();
}