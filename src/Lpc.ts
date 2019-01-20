import * as vscode from 'vscode';
import { DGDConnection } from './DGDConnection';
import { Clone } from './ClonesProvider';
import { Main } from './Main';


// e.g. status(obName)
export enum ObjectStatus 
{
	CompileTime = 0,	/* time of compilation */
	ProgramSize = 1,	/* program size of object */
	DataSize = 2,		/* # variables in object */
	Sectors = 3,		/* # sectors used by object */
	CallOuts = 4,		/* callouts in object */
	Index = 5,			/* unique ID for master object */
	Undefined = 6,		/* undefined functions */
	Inherited = 7,		/* object inherited? */
	Instantiated = 8,	/* object instantiated? */
	ToString = 9		/* called to_string() in object -- added by JR (klib was NOT modified) */
}


// e.g. "/usr/System/sys/objectd"->od_status(obName)
export enum ObjectDStatus
{
	IssueNumber = 0,
	ObjectName = 1,
	ParentArray = 2,
	ChildArray = 3,
	NumClones = 4,
	PreviousIssue = 5,
	Destroyed = 6,
	Clones = 7			// clone ids -- added by JR in ObjectD
}


// status()
export enum DgdStatus
{
	Version = 0,
	StartTime = 1,
	BootTime = 2,
	Uptime = 3,
	SwapSize = 4,
	SwapUsed = 5,
	SectorSize = 6,
	SwapRate1 = 7,
	SwapRate5 = 8,
	StaticMemorySize = 9,
	StaticMemoryUsed = 10,
	DynamicMemorySize = 11,
	DynamicMemoryUsed = 12,
	ObjectTableSize = 13,
	NumberOfObjects = 14,
	CallOutTableSize = 15,
	ShortTermCallOuts = 16,
	LongTermCallOuts = 17,
	UserTableSize = 18,
	EditorTableSize = 19,
	MaxStringSize = 20,
	MaxArraySize = 21,
	RemainingStackDepth = 22,
	RemainingTicks = 23,
	PrecompiledObjects = 24,
	TelnetPorts = 25,
	BinaryPorts = 26
}

const months: string[] = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];


class LpcError
{
	constructor(public originalString: string, public fileName: string, public line: number, public error: string)
	{
	}
}


class CallArg
{
	public val: string = "";

	constructor(public dataType: string, public label: string, public placeHolder: string)
	{
	}


    public toString = () : string => {
        return `CallArg (label: ${this.label}, placeHolder: ${this.placeHolder}, val: '${this.val}')`;
	}
}


export interface CodeResult
{
	id: number;
	success: boolean;
	error: string;
	result: any;
}


interface LooseObject
{
	[key: string]: any;
}


export class Lpc
{
	private static argumentCache: LooseObject = { };


	public static code(str : string) : string
	{
		// Pass everything through a proxy in System
		let ret = "code (\"" + Main.setting("codeAssistProxyPath").substr(0, Main.setting("codeAssistProxyPath").length-2) + "\")->code(\"" +
			str.replace(/"/g, "\\\"") +
		"\")";

		// To not use proxy, simply replace the below, but this means compile_object() will fail in most of the system.
		//return `code ${str}`;
		return ret;
	}


	public static async arbitraryCode(conn: DGDConnection)
	{
		let options: vscode.InputBoxOptions = {
			prompt: `LPC`,
			placeHolder: `Run LPC code`
		};

		await vscode.window.showInputBox(options).then(value => {
			if(value.length === 0) {
				return;
			} else {
				conn.message(value, true);
				conn.sendThen(Lpc.code(value), (cr: CodeResult) => {
					if(cr.success) {
						conn.message(this.prettify(cr.result));
					 } else {
						 conn.message(cr.error);
					 }
				});
			}
		});
	}


	/**
	 * (Re)compile an object.
	 * 
	 * @param fileName object to (re)compile
	 */
	public static compileObject(conn: DGDConnection, fileName : string, fileNameIsObjectName?: boolean): void
	{
		let fn: string;
		
		if(fileNameIsObjectName) {
			fn = fileName + (fileName.endsWith(".c") ? "" : ".c");
		} else {
			fn = conn.getFileName(fileName);
		}

		conn.sendThen(Lpc.code(Lpc.getCompileObjectSnippet(fn)), (cr: CodeResult) => {
			conn.diagnostics.delete(vscode.Uri.file(fileName));

			if(cr.success) {
				vscode.window.showInformationMessage(`(Re)compiled ${fn}`);

				// Update Object Instances view
				Main.clonesProvider.onActiveEditorChanged(Main.activeEditor());

			} else {
				let errors: LpcError[] = Lpc.getCompileErrors(cr.error);

				if(errors.length > 0) {
					// Compile error(s)
					let u;
					let diagnostics: vscode.Diagnostic[] = [];
					for(let i = 0; i < errors.length; i++) {
						u = vscode.Uri.file(Main.setting("libraryPath") + errors[i].fileName);
						diagnostics.push(
							new vscode.Diagnostic(new vscode.Range(errors[i].line - 1, 0, errors[i].line - 1, 1024), errors[i].error, vscode.DiagnosticSeverity.Error)
						);
					}
					conn.diagnostics.set(u, diagnostics);
				} else {
					// File does not exist (etc.)
					conn.message(`Compile failed, ${fn}: ${cr.error}`);
				}
			}

		});
	}


	/**
	 * 
	 * 
	 * @param fileName 
	 */
	public static destructObject(conn: DGDConnection, fileName : string, clone?: Clone): void
	{
		let obName: string = (clone === undefined ? fileName : clone.cloneName);
		let cmd: string = Lpc.getDestructObjectSnippet(obName);

		conn.sendThen(Lpc.code(cmd), (cr: CodeResult) => {
			if(cr.success) {
				if(cr.result === 1) {
					vscode.window.showInformationMessage(`Destructed ${obName}`);
					// Update Object Instances view
					Main.clonesProvider.onActiveEditorChanged(Main.activeEditor());
				} else {
					conn.message(obName + " does not exist.");
				}

			} else {
				conn.message("Destruct failed, " + obName + ": " + cr.error);
			}
		});
	}

	/**
	 * 
	 * 
	 * @param fileName 
	 */
	public static outputStatusObject(conn: DGDConnection, fileName : string, clone?: Clone): void
	{
		let obName: string = (clone === undefined ? fileName : clone.cloneName);
		let cmd: string = Lpc.getObjectStatusSnippet(obName);

		conn.sendThen(Lpc.code(cmd), (cr: CodeResult) => {
			if(!cr.success) {
				conn.message("Status failed, " + obName + ": " + cr.error);
				return;
			}

			if(cr.result === null) {
				conn.message("Status failed, " + obName + ": does not exist");
				return;
			}

			let status: any = cr.result;

			let i: number = 0;
			let msg: string = `${obName}\n`;
			let val: any = null;
			for(let s in ObjectStatus) {
				if (isNaN(Number(s))) {
					if(i === 0) {
						val = Lpc.unixTimeToDateTime(status[i++]);
					} else {
						val = status[i++];
					}
					msg += "\t" + Lpc.padRight(Lpc.camelCaseToWords(s), 23, ".") + ".." + val + "\n";
				}
			}

			conn.message(msg);
		});
	}


	/**
	 * Fetch DGD status and send it to output tab when we have it.
	 */
	public static outputDgdStatus(conn: DGDConnection): void
	{
		let c = this;
		
		conn.sendThen(Lpc.code("status()"), (cr: CodeResult) => {
			let status: any = cr.result;

			let i: number = 0;
			let msg: string = "DGD Status \\o/\n";
			let val: any = null;
			for(let s in DgdStatus) {
				if (isNaN(Number(s))) {
					if(i === 1 || i === 2) {
						val = Lpc.unixTimeToDateTime(status[i++]);
					} else if(i === 3) {
						val = Lpc.secondsToHMS(status[i++]);
					} else if(i < 24 && i > 0) {
						val = new Intl.NumberFormat('en-us', {minimumFractionDigits: 0}).format(status[i++]);
					} else {
						val = status[i++];
					}
					msg += "\t" + Lpc.padRight(Lpc.camelCaseToWords(s), 23, ".") + ".." + val + "\n";
				}
			}
			conn.message(msg);
		});
	}


	/**
	 * Parse LPC function args (and return multiple CallArg)
	 * @param args 
	 */
	public static stringToCallArgs(args: string): CallArg[]
	{
		let callArgs: CallArg[] = [];
	
		let argList: string[] = args.split(",");
		let arg: string[];
		let type: string;
	
		// TODO: replace <some> whitespace in the arg (i.e. 'mixed *' should be 'mixed*'
		// HOWEVER: some whitespace IS allowed, e.g.: "varargs mapping foo"
		for(let i = 0; i < argList.length; i++) {
			if(argList[i].trim().length === 0) {
				continue;
			}
			arg = argList[i].trim().split(" ", 2);
	
			callArgs.push(
				new CallArg(arg[0], arg[1], arg[0] + " " + arg[1])
			);
		}
	
		return callArgs;
	}
	

	private static getCompileErrors(str: string) : LpcError[]
	{
		/*
			/usr/System/open/vscode.c, 3: syntax error
			^(\/.*), ([0-9]+): (.*)
			0: all
			1: filename
			2: line
			3: error
		*/
		let ret: LpcError[] = [];
		let re = new RegExp(/^(\/.*), ([0-9]+): (.*)/gm);
		let match;
		while(match = re.exec(str)) {
			console.log("Found a compile error: " + match[0]);
			ret.push(
				new LpcError(match[0], match[1], Number(match[2]), match[3])
			);
		}

		return ret;
	}


	public static parseCodeResult(str : string): CodeResult
	{
		let i: number;
		let compileErrors: string = "";

		// We keep a duplicate here because of code-command verification (duplicate from conn.received())
		str = str.replace(/\$\d+ = "##ignore##"\s*#/gm, "");

		// Get and filter out any compile errors (TODO: look at what outputs these with message(), this is ugly)
		let parsedErrors: LpcError[] = this.getCompileErrors(str);
		for(let i = 0; i < parsedErrors.length; i++) {
			str = str.replace(parsedErrors[i].originalString, "");
			compileErrors += parsedErrors[i].originalString + "\n";
		}

		let result: CodeResult = JSON.parse(str, (k: any, v: any) => {
			if(k === "success") {
				return v === 1;
			}
			return v;
		});

		if(compileErrors.length > 0) {
			result.error = compileErrors + result.error;
		}

		if(result.success && result.result === undefined) {
			result.result = null;
		}

		return result;
	}


	private static objectToLpcString(ob: Object, pretty?: boolean): string
	{
		// Just a reverse of stringToObject(); equally unsophisticated.
		let str: string = JSON.stringify(ob, null, pretty === null ? null : 4);
		return str
			.replace(/\{/g, "([")
			.replace(/\}/g, "])")
			.replace(/\[/g, "({")
			.replace(/\]/g, "})")
			.replace(/nil/g, "null")
		;
	}


	public static prettify(cr: CodeResult): string
	{
		return this.objectToLpcString(cr, true);
	}


	public static async requestCallArgs(funcName: string, callArgs: CallArg[])
	{
		for(let i = 0; i < callArgs.length; i++) {
			await Lpc.requestCallArg(funcName, callArgs[i]);
		}
	}


	/**
	 * Get a previously entered value in a dialog.
	 * 
	 * Priority:
	 * 	1. function, datatype and variable name matches
	 *	2. datatype and variable name matches
	 *	3. variable name matches
	 *	4. nothing in cache, return empty
	 * 
	 * @param funcName 
	 * @param typeName 
	 * @param argName 
	 */
	private static getCachedArgument(funcName: string, typeName: string, argName: string): string
	{
		if(Lpc.argumentCache[funcName+":"+typeName+":"+argName]) {
			return Lpc.argumentCache[funcName+":"+typeName+":"+argName];

		} else if(Lpc.argumentCache[typeName+":"+argName]) {
			return Lpc.argumentCache[typeName+":"+argName];

		} else if(Lpc.argumentCache[argName]) {
			return Lpc.argumentCache[argName];

		} else {
			return "";
		}
	}


	/**
	 * see getCachedArgument()
	 * 
	 * @param funcName 
	 * @param typeName 
	 * @param argName 
	 * @param val 
	 */
	private static setCachedArgument(funcName: string, typeName: string, argName: string, val: string)
	{
		Lpc.argumentCache[argName] = val;
		Lpc.argumentCache[typeName+":"+argName] = val;
		Lpc.argumentCache[funcName+":"+typeName+":"+argName] = val;
	}


	public static async requestCallArg(funcName: string, callArg: CallArg)
	{
		let options: vscode.InputBoxOptions = {
			prompt: `Call ${funcName}(), ` + callArg.dataType + " " + callArg.label,
			placeHolder: `${callArg.placeHolder}`,
			value: Lpc.getCachedArgument(funcName, callArg.dataType, callArg.label)
		};

		await vscode.window.showInputBox(options).then(value => {
			if(value === undefined) {
				// cancelled, do we want to do anything else?
				callArg.val = undefined;
			} else if(value.length === 0) {
				callArg.val = "nil";
			} else if (!value) {
				callArg.val = "";
				return;
			} else {
				callArg.val = value;
			}

			Lpc.setCachedArgument(funcName, callArg.dataType, callArg.label, callArg.val);
		});
	}


	private static callArgsToString(callArgs: CallArg[]): string
	{
		let ret = "";

		// TODO in stringToCallArgs() (too):
		// 1. how we deal with e.g. "varargs mapping foo" (that is, multiple spaces in one arg)
		// 2. whether we do e.g. 'mixed *' or 'mixed*' (consistency is what counts)
		// ... more?
		for(let i = 0; i < callArgs.length; i++) {
			if(ret.length > 0) {
				ret += ", ";
			}

			// Don't quote 'nil'.
			if(callArgs[i].val === "nil") {
				ret += callArgs[i].val;
				continue;
			}

			// If prefixed with #, treat as code, regardless of type. I may revert this
			// and just not automatically quote strings.
			if(callArgs[i].val.startsWith("#")) {
				ret += callArgs[i].val.substr(1);
				continue;
			}

			switch(callArgs[i].dataType) {
				case "mixed*":
				case "string*":
				case "int*":
				case "float*":
				case "mapping":
				case "object":
				case "float":
				case "int":
					ret += `${callArgs[i].val}`;
					break;
				
				case "string":
					ret += `"${callArgs[i].val}"`;
					break;

				default :
					// default to non-string
					console.log("TODO unhandled datatype: " + callArgs[i].dataType);
					ret += `${callArgs[i].val}`;
					break;
			}
		}

		return ret;
	}


	public static padRight(str: string, size: number, filler?: string): string
	{
		if(filler === null) {
			filler = " ";
		}

		while (str.length < size) {
			str = str + filler;
		}

		return str;
	}


	public static padLeft(str: string, size: number, filler?: string): string
	{
		if(filler === null) {
			filler = " ";
		}

		while (str.length < size) {
			str = filler + str;
		}

		return str;
	}


	public static camelCaseToWords(str: string): string
	{
		let ret: string = "";
		
		for(let i = 0; i < str.length; i++) {
			if(ret.length > 0 && (str[i] >= 'A' && str[i] <= 'Z')) {
				ret += " ";
			}
			ret += str[i];
		}

		return ret;
	}


	public static unixTimeToDateTime(ts: number)
	{
		let date = new Date(ts*1000);
		// This was before I had a generic padLeft(), but this IS faster. :)
		return ("0" + date.getDate()).substr(-2) + "-" + months[date.getMonth()] + "-" + date.getFullYear() 
			+ " " + ("0" + date.getHours()).substr(-2) + ":" + ("0" + date.getMinutes()).substr(-2) + ":" + ("0" + date.getSeconds()).substr(-2);
	}


	public static secondsToHMS(secs: number)
	{
		let hours = Math.floor(secs / 3600);
		secs %= 3600;
		let minutes = Math.floor(secs / 60);
		let seconds = secs % 60;
		return `${Lpc.padLeft(""+hours, 2, "0")}:${Lpc.padLeft(""+minutes, 2, "0")}:${Lpc.padLeft(""+seconds, 2, "0")}`;
	}


	public static isInheritable(obName: string)
	{
		return obName.indexOf("/lib/") >= 0;
	}


	public static isLWO(obName: string)
	{
		return obName.indexOf("/data/") >= 0;
	}


	public static getClonesToStringSnippet(obName: string, cloneIds: number[]): string
	{
		if(!cloneIds) {
			return "({ })";
		}

		return (Main.setting("showLpcSnippetComment") ? '/* snippet 001 */' : '') +
			'd = "' + obName + '";' +
			'z = ({ ' + cloneIds.join(",") + ' });' +
			'a = ({ });' +
			'for(b = 0; b < sizeof(z); b++) {' +
			'	n = (d + "#" + z[b]);' +
			'	t = "";' +
			'	catch( t = n->to_string() );' +
			'	a += ({ t });' +
			'}' +
			'return a;';
	}


	/**
	 * Get 'code' snippet to fetch object status and its to_string()
	 * 
	 * I don't want to call to_string() on files in lib or data folders. 
	 * Calling an LWO is possible, but only if you hold a reference to it. 
	 * Not possible from a string.
	 * 
	 * Dilemma is, I don't know where -your- objectd is and what your 
	 * restrictions are, so will just go with kernel lib's default to find 
	 * out if something is a lib.
	 * 
	 * In driver.c we have: if(sscanf(path, "%*s" + INHERITABLE_SUBDIR) != 0 
	 *                         || (objectd && objectd->forbid_call(path)))
	 * 
	 * @param obName 
	 */
	public static getObjectStatusSnippet(obName: string)
	{
		let obStr: string;

		if(Lpc.isInheritable(obName)) {
			obStr = `"Inheritable"`;
		} else if(Lpc.isLWO(obName)) {
			obStr = `"LWO"`;
		} else {
			obStr = `("${obName}")->to_string()`;
		}

		return (Main.setting("showLpcSnippetComment") ? '/* snippet 002 */' : '')
			+ `v = "";`
			+ `catch( v = ${obStr} );`
			+ `if ((a = status("${obName}")) != nil) {`
			+ `		return ( a + ({ v }) );`
			+ `} else {`
			+ `		return nil;`
			+ `}`
			;
	}


	/**
	 * Get 'code' snippet for fetching clone ids of a master object.
	 * 
	 * @param obName 
	 */
	public static getCloneIdsSnippet(obName: string): string
	{
		if(Main.setting("cloneIdsCall") !== null && Main.setting("cloneIdsCall").length > 0) {
			return (Main.setting("showLpcSnippetComment") ? '/* snippet 004 */' : '')
				 + Main.setting("cloneIdsCall").replace("$1", obName);
		} else {
			return (Main.setting("showLpcSnippetComment") ? '/* snippet 005 */' : '')
				+ `"/usr/System/sys/objectd"->get_clone_ids("${obName}")`;
		}
	}


	/**
	 * Get 'code' snippet to do a call_other() ( -> )
	 * 
	 * @param objectName 
	 * @param funcName 
	 * @param callArgs 
	 */
	public static getCallSnippet(objectName: string, funcName: string, callArgs: CallArg[]): string
	{
		let args: string = Lpc.callArgsToString(callArgs);
		return (Main.setting("showLpcSnippetComment") ? '/* snippet 006 */' : '')
			+ `("${objectName}")->${funcName}(${args})`;
	}


	public static getCompileObjectSnippet(fileName: string): string
	{
		// ugh, wiztool's compile_object() does not want .c
		if(fileName.endsWith(".c")) {
			fileName = fileName.substr(0, fileName.length - 2);
		}
		return (Main.setting("showLpcSnippetComment") ? '/* snippet 007 */' : '')
			+ `compile_object("${fileName}")`;
	}


	public static getDestructObjectSnippet(fileName: string): string
	{
		return (Main.setting("showLpcSnippetComment") ? '/* snippet 008 */' : '')
			+ `destruct_object("${fileName}")`;
	}
}
