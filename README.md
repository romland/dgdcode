# DGD Code Assist README
Some time back I dipped my toes into the wonderful world of DGD again. I am
using it as the server for a multi-player mobile device game. I'm confident 
that that I am not alone in feeling this; if you work with DGD outside of 
the scope of MUDs it becomes a bit painful to not have your entire workflow in 
the editor (no fault of DGD). 

So, I had merely dabbled a bit in Visual Studio Code prior to this, but 
had read good stuff and it seems to be all the rage for a lot of people 
these days. Thus, this editor extension was conceived.


## Features
Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

Some features include:
- Simulated intellisense for DGD's 97 kfuns (as well as kernel library's)
- Recompile on save (optional)
- Acting on compile errors (click error to go to problem)
- Execute function in current scope
- The standard stuff: status, recompile, destruct etc are available as 
  commands (and context menus).
- Run arbitrary code from dialog (although, personally I just add a 
  function in a "scrap book" object and press ctrl/cmd+e to just execute 
  it there). Which turned out to be a welcome addition to my workflow.
- List and work with clones (and their master object)
- Object status (on hover in added "object instances" view)
- The editor will call to_string() in objects to give an "at-the-glance" 
  idea of what is going on. It's a simple idea, but it's helped me 
  enormously. Say, I select "gamed.c" in the editor and the comment
  next to its name will then say "152 active games". I had no idea 
  I *needed* it. This combined with being able to safely tweak and 
  recompile objects that are in a live environment ... well, I love
  DGD for it. But I know I am preaching to the choir, here.
- "Prettify" output of data
- Follow (DGD) log in built-in terminal (which I must confess to not
  using much myself as I want focus on output tab)
- Plenty of things to change in settings. Search for 'dgd' and they
  should appear. Because of my laziness, you have to restart editor 
  if you change DGD related settings.
- ... `and more`.


## Important notes
### File transfers
This extension does not do any file-transfers (there are plenty of extensions for this. 
DGD Code Assist is written to be used on a local filesystem. You can probably use it 
with a mounted remote filesystem, but that was not my use-case.

### UI updates
It can look like the extension is sluggish, but it really isn't. It's all asynchronous
operations but VSCode will treat most UI updates with less priority to stay snappy (which is fine).
The Output tab is a great example for instance, it will only output data there a 
couple of times per second.

### Proxy in ~System
In order to be able to sanely communicate with DGD I needed to have some resemblence
of a messaging protocol. Something which is parsable. In order to be able to use, say,
compile_object() all over the system it also needed to be privileged. So, there's a 
small program called code_assist.c that gets inserted into the library.

By default it sits in /usr/System/sys/code_assist.c. This proxy gets installed there
when you log in to DGD. Version is checked on every startup and if an upgrade is needed
it will attempt to do so.

Again, by default, it only allows /usr/admin/ to use its functionality.

The source to code_assist.c can be found [here](https://github.com/romland/dgdcode).

That said, the automatic installation might not be something that you want since you 
may have tweaked the proxy's functionality. So, you can turn the automatic installation 
off and do it manually:
1. Disable the setting codeAssistProxyInstall
2. Copy code_assist.c into a privileged location of your DGD library.
3. Make sure it is compiled on start up of DGD (typically from initd.c or so).
4. Tell the extension the location of the proxy by changing the codeAssistProxyPath setting


## Requirements (some optional)
If you are familiar with DGD, it's nothing out of the ordinary, really.
- [Visual Studio Code](https://code.visualstudio.com/)
- [DGD](https://github.com/dworkin/dgd)
- [Felix' Kernel Library](https://github.com/dworkin/kernellib).
  That said, any lib will work as long as the
  "code" command is the same (or at least looks the same). In my case
  Kernel Library's wiztool is completely unmodified. Making these
  assumptions configurable is definitely an option, though. I have 
  just not needed to.
- [An objectd](https://github.com/dworkin/phantasmal/blob/master/mudlib/mud/usr/System/sys/objectd.c) (optional).
  If you want to work with individual clones you will want something like an objectd. Personally 
  I snagged this one, added a patch to track clones and allowed /usr/admin/ to query for clone 
  IDs of a master object.
- [C/C++ extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) (optional).
  For scope detection (for calling current function, etc) I rely on this extension. It's something you 
  want for syntax highlighting, etc, as well. That extension is flagged as a dependency and editor will 
  act accordingly.


# How to install
Default settings are meant to work in normal situations, but if you are having doubts it is probaby
wise to read this document (at least the bits above).

TODO
1. Install Visual Studio Code
2. ...more instructions should be here...

X. If workspace is not already open, open it by doing `File->Open Folder`. The root of your workspace must be the root
   of the Kernel Library (or your "MUD"). If this is not the case, the extension will warn you when starting up.



## Optional tweak(s) to Kernel (or your own) Library
Technically, no tweaks are *needed* other than the insertion of code_assist.c. 
That said, I do recommend the following...


### ObjectD
Support for clone tracking is very handy as it enables you to call functions in,
destruct, etc, a specific clone. The extension will need to be able to query your 
objectd for clone IDs of a master object. Below is the function I added to Noah 
Gibbs' public domain ObjectD.
```
  /*
  You may want to make sure only programs in /usr/admin/ and /usr/system/ can 
  call it.

  int* get_clone_ids(string object_name);
    return ({ clone-id, clone-id, ... }) (integers)
    return ({ }) if master object is compiled but has no clones
    return ({ }) if object does not exist
  */
  int* get_clone_ids(string obj)
  {
    object issue;
    int index;

    if(!ADMIN() && !SYSTEM())
      error("not allowed");

    if(find_object(obj)) {
      index = status(find_object(obj))[O_INDEX];
    } else {
      if(status(obj)) {
        index = status(obj)[O_INDEX];
      } else {
        return ({ });
      }
    }

    issue = obj_issues->index(index);

    if(!issue)
      return ({ });

    /* This is where we get the IDs of each clone for this master object. The rest is boiler plate to get there. */
    return issue->get_clones();
  }
```

### Using `to_string()` in your LPC objects
> Note: This is not really for the Kernel Library, but I needed a place for this information.
The function `to_string()` can be added to any object. The editor will call it to show relevant information about a clone 
or master object. I use it quite extensively.

```
  string to_string()
  {
      return sizeof(players) + " players online";
  }
```


## Default keybindings
* `Ctrl+E` (in editor) execute function at the cursor.
* `Ctrl+Alt+R` (in editor) (re)compile current object.
* `Ctrl+Alt+S` (in editor) get status of current object.
* `Ctrl+Alt+D` (in editor) destruct current master object (handy with libraries).


## Extension Settings
DGD Code Assist contributes the following settings:
* `libraryPath`: Absolute path to the folder of your DGD library.
* `host`: DGD host.
* `port`: DGD port.
* `user`: DGD user.
* `userPassword`: User password.
* `openFolderOnStartup`: Open libraryPath when you start editor (used primarily for development of this extension)
* `recompileOnSave`: Recompile on save.
* `dgdLogFollow`: Tail -f DGD's log.
* `dgdLog`: Location of DGD's log.
* `cloneIdsCall`: The LPC call to fetch clone IDs of a master object.
* `forceCExtensionConf`: Force configuration of C/C++ language extension to be more suitable for LPC.
* `showLpcSnippetComment`: Will show an identifier for built-in LPC snippets to make things easier to debug when they go wrong in the extension.
* `codeAssistProxyInstall`: Install code_assist.c automatically into your DGD library. Turn off in case you made tweaks to code_assist.c.
* `codeAssistProxyPath`: This proxy sits between the default code command and your DGD Library. It will grant the editor global access and return queried data as JSON. At this point the proxy only grant access to /usr/admin/*, but you can modify the file to grant access to other user directories.


## Known Issues
See "Nice to have some day" as well.
- Bits and pieces of the code is very prototypy as I had never touched VSCode, node or 
  typescript, before. As so often, most of the  time went into figuring out the platform.
  Some things could use a rewrite.
- There is a pile of TODOs in the code that are of varying degrees of urgency

## Nice to have some day
- Make the LPC language a first-grade citizen. It would be nice to have
  code-completion for e.g. functions in sub-classes. But I found that 
  the C/C++ language extension is good enough for me (the understanding
  and expansion of precompile statements and syntax highlighting is 
  spot on, for instance). If there was a full-featured language server 
  for LPC out there, I'd be all over it, though. 
  If someone is feeling brave: 
  [LSP Reference](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide)
  (the LSP specification is supposedly editor agnostic)
- Code completion of k/e-funs is a bit of a hack as it should arguably 
  be part of an LSP extension. Here I use snippets with array matching. This 
  work-around turned out better than I thought.
- Make kernel library assumptions configurable; such as code results being prefixed with '$',
  and prompts being '#', etc. This would make the extension easier to use in environments
  not using Kernel Library.
- Make calling of to_string() configurable (issue: this setting needs to propagate to code_assist.c when it is changed)
- In dialogs of function arguments/code, arrow up/down for history would be nice
- A "fake terminal" for arbitrary commands that sits on the same connection as the one we use for code commands.
- An easy way to get to documentation of e/l/kfuns from editor
- Change configuration without having to restart editor


## Release Notes
### 1.0.0 Initial release
It works for me. :)

## About DGD
DGD is fantastic.

### Why do *I* use DGD?
Imagine this: never having any downtime. All while being able to tweak, test, destroy, 
add and recompile live objects while your entire world is up and running. Your users 
will never notice a thing. Well, except new and improved content.

Couple this up with the ability to have transactions that will be rolled back if an 
error is encountered and you're a happy panda (think: server-to-server transfers).

Need to upgrade hardware? Take a statedump of the world, spin up a new server, add the
statedump there, automatically transfer logged in users to that server, then do your 
hardware upgrade. Again, logged in users will merely have a hiccup.

If the statedump thing did not fully make sense, let's just say that you'll never need
to persist any data to disk, the *world* is the data and DGD is your database and you have 
it all by just taking a statedump (incremental or not).

The language you use, LPC, is very pleasant to work with. It's typed and garbage collected.
It's close to C, but without the dangerous bits.

DGD is small and performant. Performance critical objects can be pre-compiled to C and
linked with DGD making them even speedier.

Don't let its age fool you, I just returned to it after 14 years of working with other
platforms and I am enjoying the environment *immensely*.

Oh, I forgot to mention that DGD is made to support dozens of simultaneous developers.


So... why do I use DGD? 
Because DGD is fantastic.

### DGD Links

- [Github](https://github.com/dworkin/dgd)
- [Mailing list](https://mail.dworkin.nl/mailman/listinfo/dgd)
- [dworkin.nl/dgd/](http://www.dworkin.nl/dgd/)
- [FAQs](http://dgd.is-here.com/faq/)

Why haven't you heard about DGD before? God knows.


**Enjoy.**
