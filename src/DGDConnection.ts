import * as vscode from 'vscode';
import { Lpc, CodeResult } from './Lpc';
import { Main } from './Main';
import net = require('net');
import fs = require('fs');

enum CommandType
{
	Login = 1,
	Code = 2,
	Other = 3
}


/**
 * Represents a command and a callback to pass result data to.
 */
class DgdCommand
{
	constructor(public cmdId: number, public cmdType: CommandType, public sent: string, public callback?: {(codeResult: CodeResult) : void;})
	{
	}


	/**
	 * Notify callback with response.
	 * 
	 * @param response data from DGD
	 */
	notify(codeResult: CodeResult): void
	{
		if(this.callback !== undefined) {
			this.callback(codeResult);
		}
	}
}


/**
 * DGDConnection
 * 		Handles sending and receiving of data from DGD. Also holds information
 * 		specific to this DGD instance, such as file paths.
 * 
 * 		We do not use the standard "code" command for a few reasons:
 * 		- it is not privileged (need global compile_object())
 * 		- parsing of results is extremely fragile (and especially so with errors)
 * 		- we cannot easily make messages out of the result
 * 		- we cannot easily match a command with a result
 * 
 * 		So, we use a proxy in ~System that is privileged and return JSON
 * 		messages tagged with an ID.
 * 
 *		This privileged object is inserted into the library as
 *		/usr/System/sys/code_assist.c automatically.
 */
export class DGDConnection
{
	private conn : net.Socket;
	private commandQueue: DgdCommand[] = [];
	public diagnostics: vscode.DiagnosticCollection = vscode.languages.createDiagnosticCollection("DGD");
	private output: vscode.OutputChannel = vscode.window.createOutputChannel("DGD");
	private connectAttempts: number = 0;

	private loggingIn: boolean = false;
	private loggedIn: boolean = false;

	private codeCommandCount: number = 0;
	private installingNewProxy: boolean = false;
	private installedNewProxy: boolean = false;


	/**
	 * C'tor. Initialize a start a connection to DGD.
	 * 
	 * @param libPath path to klib root
	 * @param port DGD port
	 * @param login DGD user
	 * @param password DGD user password
	 */
	constructor(public readonly libPath: string, private host: string, private port: number, private login : string, private password : string)
	{
		this.output.show(true);
		this.conn = new net.Socket();
		this.connect();
	}


	/**
	 * Called by Main on extension deactivation.
	 */
	destructor()
	{
		this.close();
		this.diagnostics.dispose();
		this.output.dispose();
	}


	/**
	 * Send to output tab.
	 * 
	 * This does not -really- belong here, but I want to have an output-opportunity on 
	 * a per-connection basis.
	 * 
	 * VSCode team says:
	 * "The Output Channel is designed to show a continues stream of output, like tail -f. The use-case we had 
	 * in mind are task runners, language server/service output etc. Which are the classic samples of append and 
	 * reveal."
	 * 
	 * https://code.visualstudio.com/api/references/vscode-api#OutputChannel
	 * 
	 * @param msg 
	 * @param isInput 
	 */
	public message(msg: string, isInput?: boolean): void
	{
		this.output.append((isInput ? "> " : "") + msg + "\n");
		this.output.show(true);	// false = output tab will steal focus
	}


	/**
	 * Set up socket operations and connect to DGD.
	 */
	private connect(): void
	{
		this.conn.removeAllListeners();

		this.conn.connect(this.port, this.host, () => {
			this.connectAttempts++;
		});

		this.conn.on('data', (str: string) => {
			this.received(str);
		});

		this.conn.on('close', () => {
			this.close();
		});

		this.conn.on("error", (err: any) => {
			this.message(err);
			console.log(err + "\n" + err.stack);
			this.close();
		});
	}


	/**
	 * Log in to DGD.
	 */
	private logIn(): void
	{
		// FUCK ME. Clean this shit up and use await/async.

		this.sendThen(`${this.login}`, (cr: CodeResult) => {
			if(cr.result.indexOf("Password:") < 0) {
				vscode.window.showErrorMessage(`Failed to log in to DGD with user ${this.login}.`);
				this.close();
				return;
			}
			this.sendThen(`${this.password}`, (cr: CodeResult) => {
				if(cr.result.indexOf("#") < 0) {
					vscode.window.showErrorMessage("DGD password not accepted.");
					this.close();
					return;
				}

				// Make sure we have Code Assist proxy in place.
				this.setupCodeAssistProxy((cr: CodeResult) => {
					if(Main.setting("codeAssistProxyInstall")) {
						if(!cr.success) {
							// We failed to properly find and set up proxy. Bail out.
							// XXX: Should we close connection?
							console.error(cr.error);
							this.message(`Failed to properly find and/or install ${Main.setting("codeAssistProxyPath")}:\n` + cr.error);
							return;
						} else {
							console.error(cr.result);
						}
					} else {
						let msg: string = "Automatic installation and setting up of code_assist proxy was disabled...";
						console.error(msg);
						this.message(msg);
					}

					// Check to see if the proxy'd code command behaves as expected
					this.sendThen(Lpc.code(`"Success"`), (cr: CodeResult) => {
						if(!cr.success) {
							this.message("Code command is incompatible. DGD Code Assist will not work properly. Unexpected result was:\n" + JSON.stringify(cr));
							this.close();
							return;
						} else {
							// Make sure our command IDs will match those of DGD's.
							this.codeCommandCount = cr.id + 1;
						}

						this.loggedIn = true;
						this.message(`Connected to DGD as ${this.login}.`);

						Main.clonesProvider.onActiveEditorChanged(Main.activeEditor());
						Main.scopeHandler.fetchDocumentSymbols(Main.activeEditor().document).then(() => {
							console.log("Got symbols after logging in.");
						});

						// Output DGD status on first log in.
						if(this.connectAttempts === 1) {
							Lpc.outputDgdStatus(this);
						}
					});
				});

			});
		});
	}


	/**
	 * Hook for getting received data.
	 * 
	 * @param str data received
	 */
	private received(str: string): void
	{
		str = str.toString();

		// On first data we see...
		if(!this.loggingIn) {
			this.loggingIn = true;
			this.logIn();
			return;
		}

		let cmd: DgdCommand;

		// Responses during log in process should not be parsed. Note that we also do 
		// a pre-check of the klib code command at this stage.
		while(this.commandQueue.length > 0) {
			if(this.commandQueue[0].cmdType === CommandType.Login) {
				let cr: CodeResult;
				if(str.indexOf("##ignore##") >= 0) {
					cr = Lpc.parseCodeResult(str);
				} else {
					// Fake an object as login-stuff cannot go through code-commands.
					cr = {
						"id" : 0,
						"success" : true,
						"result" : str,
						"error" : null
					};
				}
				this.commandQueue.shift().notify(cr);
				return;
			} else {
				break;
			}
		}

		// Are we getting data from commands we have not sent?
		// Most likely cause: we failed to match up a command with a result prior to this.
		if(this.commandQueue.length === 0) {
			let s: string = `Unexpected data: ${str}`;
			this.message(s);
			console.log(s);
			return;
		}

		// ...we must now have a code-command result...

		// TODO: Actually verify that we have "##ignore##" at end of our result.
		//       If we don't, then wait for more data before parsing.
		let cr: CodeResult;
		let match: RegExpExecArray;
		let resultStart: number = 0;
		let resultEnd: number = 0;
		let result: string;

		let re = new RegExp(/(.*)(\s\$\d+ = "##ignore##"\s*#)/gm);
		while(match = re.exec(str)) {
			resultEnd = str.indexOf(match[2]);
			result = str.substr(resultStart, resultEnd-resultStart);
			resultStart = resultEnd + match[2].length;
			cr = Lpc.parseCodeResult(result);
			cmd = this.getCommandInQueue(cr.id, CommandType.Code);
			if(cmd === null) {
				this.message("Received data for unknown command: " + JSON.stringify(cr));
				continue;
			}
	
			console.log("Recd " + cmd.cmdId + ": " + JSON.stringify(cr));
			cmd.notify(cr);
		}

	}


	private getCommandInQueue(cmdId: number, cmdType: CommandType): DgdCommand | null
	{
		let cmd: DgdCommand;

		for(let i = 0; i < this.commandQueue.length; i++) {
			if(this.commandQueue[i].cmdId === cmdId) {
				cmd = this.commandQueue.splice(i, 1)[0];
				return cmd;
			}
		}

		console.error("Command not found for " + cmdId + " of type " + CommandType[cmdType]);
		return null;
	}


	/**
	 * Reconnect on lost connection.
	 */
	public reconnect(): boolean
	{
		if(!this.loggingIn && (this.conn === null || this.conn.destroyed)) {
			this.message("Connection was gone, reconnecting...");
			this.connect();
			return true;
		}
		return false;
	}


	/**
	 * Send data and call back when we get response.
	 * 
	 * @param str data to send
	 * @param responseCallback callback for when we get response 
	 */
	public sendThen(str: string, responseCallback: {(response: CodeResult) : void;}): void
	{
		if(this.reconnect()) {
			return;
		}
		
		let commandType: CommandType;
		let commandId: number;

		if(!this.loggedIn) {
			commandType = CommandType.Login;
			commandId = 0;

		} else if(str.startsWith("code ")) {
			commandType = CommandType.Code;
			commandId = this.codeCommandCount;
			this.codeCommandCount = (this.codeCommandCount + 1) & 2147483647;

		} else {
			console.error("Only support sending of code commands, attempted to send: " + str);
			return;
		}

		this.commandQueue.push(new DgdCommand(commandId, commandType, str, responseCallback));
		this.conn.write(str + "\n");

		console.log(`Sent ${commandId}: ${str}`);
	}
	

	/**
	 * Close connection to DGD.
	 */
	public close(): void
	{
		this.loggedIn = false;
		this.loggingIn = false;

		if(!this.conn.destroyed) {
			this.message("Connection to DGD closed.");
			this.conn.end();
			this.conn.destroy();
		}
	}


	/**
	 * Get absolute path to the root of the Kernel Library.
	 */
	public dgdLibPath(): string
	{
		return this.libPath;
	}


	/**
	 * Path to a file within DGD from a filesystem filename.
	 * 
	 * @param f e.g. vscode.window.activeTextEditor.document.fileName
	 */
	public getFileName(f : string): string
	{
		return f.substr(this.dgdLibPath().length).replace(/\\/g, "/");
	}


	/**
	 * Path to an object within DGD from a filesystem filename.
	 * 
	 * Object name (as opposed to file name) ditches .c at the end of a file.
	 * 
	 * @param f e.g. vscode.window.activeTextEditor.document.fileName
	 */
	public getObjectName(f : string): string
	{
		let ret: string = this.getFileName(f);
		return ret.substr(0, ret.length - 2); // ditch .c
	}


	/**
	 * A lot of mucking about just to place and compile a privileged proxy that
	 * /usr/admin/_code.c can use. And ALL this just to enable admin to do 
	 * compile_object() all over the system (well, and returning sane JSON objects
	 * to create an illusion of a message protocol).
	 * 
	 * @param callBack 
	 */
	private setupCodeAssistProxy(callBack: {(response: CodeResult) : void;})
	{
		let result: CodeResult = {
			id: -1,
			success: true,
			error: null,
			result: null
		};

		let proxyPath: string = Main.setting("codeAssistProxyPath");
		let proxyVersion: number = Main.requireCodeAssistProxyVersion;

		console.error("Proxy path: " + proxyPath);
		
		if(proxyPath === null || proxyPath === "" || proxyPath === undefined) {
			console.error("No path to proxy is configured! Refusing to start.");
			result.success = false;
			result.error = "Proxy path is not configured in settings.";
			callBack(result);
			return;
		}

		// We want this to return 1, but need to deal with all negative outcomes.
		let lpc: string = ``
		+ `    p = "${proxyPath}";`
		+ `    v = ${proxyVersion};`
		+ ``
		+ `    catch {`
		+ `        if(p[strlen(p)-2..] != ".c") {`
		+ `            return -1;`
		+ `        }`
		+ ``
		+ `        q = p[..strlen(p)-3];`
		+ `        if((o = find_object(q)) == nil) {`
		+ `            return -2;`
		+ `        }`
		+ ``
		+ `        if(o->version() != v) {`
		+ `            return -3;`
		+ `        }`
		+ `    } : {`
		+ `        return -4;`
		+ `    }`
		+ ``
		+ `    return 1;`
		;

		
		let root: string = vscode.workspace.rootPath; // e.g. i:\TreeGame\dgd\klib\src
		let extensionRoot: string = vscode.extensions.getExtension ("jromland.dgdcode").extensionPath;

		if(!fs.existsSync(root + "/include/status.h")) {
			result.success = false;
			result.error = "Could not locate /include/status.h. Workspace root must be the root of your DGD library.";
			callBack(result);
			return;
		}
		console.error("Workspace root looks okay...");

		if(!fs.existsSync(root + proxyPath)) {
			let codeAssistFilePath: string = extensionRoot + "/code_assist.c";

			if(!fs.existsSync(codeAssistFilePath)) {
				result.success = false;
				result.error = "Could not locate code_assist.c in extension folder: " + extensionRoot;
				callBack(result);
				return;
			}
			console.error("File code_assist.c exists in extension folder...");

			fs.copyFileSync(codeAssistFilePath, root + proxyPath);
			console.error(`Copied ${codeAssistFilePath} to ${root + proxyPath}...`);
		}

		this.sendThen(`code ${lpc}`, (cr: CodeResult) => {
			// This is a plain code result which, if all went well, will look like: $0 = 1\r\n# 
			let match = new RegExp(/^\$\d+ = (.*)/).exec(cr.result);
			if(match === null || match.length < 2) {
				result.success = false;
				result.error = "Could not find result code";
				callBack(result);
				return;
			}

			if(isNaN(Number(match[1]))) {
				result.success = false;
				result.error = "Invalid result code: " + match[1];
				callBack(result);
				return;
			}

			let proxyTestResult: number = Number(match[1]);

			console.error(`Proxy test returned ${proxyTestResult}`);

			switch(proxyTestResult) {
				case 1 :
					result.success = true;
					result.result = "Proxy is already installed and compiled.";
					callBack(result);
					return;
	
				case -1 :
					result.success = false;
					result.error = "Proxy must be a filename ending with .c";
					callBack(result);
					return;

				case -2 :
					console.error("Proxy not compiled, compiling it...");
					this.sendThen(`compile ${proxyPath}`, (cr: CodeResult) => {
						let match = new RegExp(/^\$\d+ = (.*)/).exec(cr.result);

						if(match === null || match.length < 2 || match[1] !== "<" + proxyPath.substr(0, proxyPath.length - 2) + ">") {
							result.success = false;
							result.error = "Failed to compile proxy: " + cr.result;
							callBack(result);
							return;
						} else {
							console.error("Compile successful.");
							// Do a sanity check again now (especially version)...  (WARNING: Recursion)
							this.installedNewProxy = true;
							this.setupCodeAssistProxy(callBack);
							return;
						}
					});
					return;

				case -3 :
					// Attempt to fix this situation by replacing the proxy with the latest we have available. (WARNING: Recursion)
					if(this.installingNewProxy || this.installedNewProxy) {
						// Attempted, but evidently failed since we're here again.
						result.success = false;
						result.error = "Proxy is of wrong version, expected " + proxyVersion;
						callBack(result);
					} else {
						// Attempt to uninstall, then get back in here to reinstall latest -- but only once.
						this.installingNewProxy = true;
						console.error("Proxy is of wrong version, uninstalling current...");
						this.message("Upgrading proxy...");
						this.sendThen(`code "${proxyPath.substr(0, proxyPath.length - 2)}"->uninstall()`, (cr: CodeResult) => {
							console.error("Uninstall returned: " + cr.result);
							this.setupCodeAssistProxy(callBack);
						});
					}
					return;

				default :
					// This likely means the vanilla code command is behaving unexpectedly. Don't think there's much I can do.
					result.success = false;
					result.error = "Problem, most likely due to incompatible 'code' command. Unknown result code " + proxyTestResult;
					callBack(result);
					return;
			}

			// we should never get here

		});

		// and if we get here, means all went well ... for now
	}

}