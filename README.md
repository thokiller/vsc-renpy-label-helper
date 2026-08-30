# Ren'Py Label Tool

A VS Code extension that keeps `jump`, `call`, screen and python-function references in a Ren'Py project honest: it tells you when a target does not exist, and lets you navigate between definitions and their usages.

## Feature overview

| # | Feature | How you use it |
| --- | --- | --- |
| 1 | [Missing label and screen validation](#1-missing-label-and-screen-validation) | Warnings in the editor and Problems panel |
| 2 | [Case-sensitive typo detection + quick fix](#2-case-sensitive-typo-detection--quick-fix) | Light bulb on the flagged target |
| 3 | [Project-wide missing target overview](#3-project-wide-missing-target-overview) | Status bar button `Ren'Py Labels` |
| 4 | [Label insert tool with cross-partial search](#4-label-insert-tool-with-cross-partial-search) | Status bar button `Insert Ren'Py Label` |
| 5 | [Go to definition across files](#5-go-to-definition-across-files) | `Ctrl` + click on a target |
| 6 | [Find usages from a definition](#6-find-usages-from-a-definition) | `Ctrl` + click on the definition name |
| 7 | [Python function navigation](#7-python-function-navigation) | `Ctrl` + click on a call or on `def name` |

---

### 1. Missing label and screen validation

Every reference is resolved against the definitions found in the project and reported as a warning when it does not exist. Matching is **case sensitive**, exactly like Ren'Py.

Validated reference forms:

| Form | Example | Checked against |
| --- | --- | --- |
| Plain jump / call | `jump chapter_two`, `call helper` | `label` / `menu <name>:` |
| Local label | `jump .retry` | `label .retry:` in the enclosing label |
| Expression string | `jump expression "chapter_two"`, `call expression "helper"` | `label` |
| Screen statements | `call screen shop`, `show screen hud`, `hide screen hud`, `use hud` | `screen <name>:` |
| Python helpers | `renpy.jump("x")`, `renpy.call("x")`, `renpy.jump_out_of_context`, `renpy.call_in_new_context` | `label` |
| Screen helpers | `renpy.call_screen("x")`, `renpy.show_screen("x")`, `renpy.hide_screen("x")` | `screen` |
| Screen actions | `Jump("x")`, `Call("x")`, `Show("x")`, `Hide("x")`, `ShowMenu("x")` | `label` / `screen` |

Definitions collected: `label name:`, `label .local:`, `menu name:`, `screen name(...):`, the `_call_*` name from a `from` clause, and `def name(...)` for python.

### 2. Case-sensitive typo detection + quick fix

If a target does not exist but a definition with the same name in different casing does, the warning names it:

> Label "Chapter_Two" does not exist. Ren'Py names are case sensitive; did you mean "chapter_two"?

The light bulb then offers `Fix casing: use "chapter_two"`, which rewrites only the target. A local reference such as `.Retry` keeps its short form and becomes `.retry`.

### 3. Project-wide missing target overview

The status bar button at the bottom left shows the live count:

- `$(check) Ren'Py Labels` — everything resolves.
- `$(warning) Ren'Py Labels: N` — N unresolved targets.

Clicking it rescans the project and opens a searchable list of every unresolved `jump`/`call`/screen target, showing the name, the statement kind, and the file and line. Selecting an entry opens it. The same findings appear in the Problems panel.

### 4. Label insert tool with cross-partial search

The `Insert Ren'Py Label` status bar button catalogs every label in the scanned folders and lists:

- the label name
- the file path relative to the workspace root, plus the line number

Search is **cross-partial**: space-separated terms must all match, in any order, against either the name or the path. For example `chapter two intro` matches label `two_intro` in `game/chapters/chapter_2.rpy`. Labels whose name starts with a term rank first.

Selecting an entry inserts the label name at the cursor, replacing the selection if there is one. With no active editor the name is copied to the clipboard instead.

### 5. Go to definition across files

`Ctrl` + click, `F12` or `Alt` + `F12` on a target opens its definition, in whichever file it lives. It works for plain targets, local `.label` targets, expression strings, screen references, `use` statements and python helper calls.

Resolution is case sensitive, so a mis-cased target does not navigate; it is flagged instead (see feature 2).

### 6. Find usages from a definition

`Ctrl` + click on the **name in a definition** does the reverse. On `label chapter_one:`, `screen my_screen():` or `def my_helper(...):` it opens a peek list of every place that name is used, so you can jump straight to any call site.

`Shift` + `Alt` + `F12` (Find All References) works from both a definition and a usage.

### 7. Python function navigation

`def` statements in `init python:` blocks, `.rpy` python blocks and project `.py` files are indexed.

- From a call such as `get_item_purchase_label(item, 1)` or `store.get_item_purchase_label(...)`, `Ctrl` + click jumps to the `def`.
- From `def get_item_purchase_label(...)`, `Ctrl` + click lists all call sites.

Dotted access resolves on the last segment, so `self.method(...)` finds `def method(...)`. Names with no `def` in the project (engine and standard library functions) simply do not resolve, and function references never produce warnings.

---

## What gets scanned

- Default roots: the `game` folder. If it does not exist in a workspace folder, that whole folder is scanned. Configurable with `renpyLabelTool.scanRoots`.
- File types: `.rpy`, `.rpym` and `.py`.
- Unsaved editor content is used when a file is open, so results follow what you are typing.
- The index refreshes on edit, save, file creation/deletion and configuration change.

## Parsing details

**Comments, dialogue and docstrings are ignored.** `#` comments are stripped, single-line string contents are masked, and multi-line `"""` / `'''` docstrings are tracked across lines. A keyword only counts when it starts a statement (line start, or after the `:` of an inline block), so neither `Get the label to call for purchasing an item.` in a docstring nor `"I will call you later"` in dialogue is treated as a `call`.

**All `call` clause forms resolve to the same target.**

```renpy
call foo
call foo(1, 2)
call foo pass (1, 2)
call foo from _call_foo_1
call expression "foo" pass (1) from _call_foo_2
call screen foo(1)
```

The `_call_*` name introduced by a `from` clause is registered as a label, so nothing else flags it.

**Local labels.** `label .retry:` inside `label chapter_one:` is indexed as `chapter_one.retry`; `jump .retry` resolves against the enclosing global label.

**Screens are a separate namespace.** A screen name is never matched against labels or vice versa. Engine screens (`say`, `choice`, `preferences`, ...) are pre-listed in `renpyLabelTool.ignoredScreens`, so they are not flagged when your project does not define them.

**Dynamic targets are skipped.** When a target cannot be reduced to a fixed name (`jump expression chapter_var`, `renpy.jump("ch_" + str(n))`) it is ignored. Set `renpyLabelTool.reportDynamicTargets` to `true` to list them as unverifiable instead.

## Commands

| Command | Description |
| --- | --- |
| `Ren'Py: Show Missing Label Overview` | Rescan and list every unresolved target. |
| `Ren'Py: Insert Label From Project` | Search all labels and insert one at the cursor. |
| `Ren'Py: Rescan Labels And Screens` | Rebuild the index manually. |

Both overview and insert commands are also available as status bar buttons and in the editor title bar of `.rpy`/`.rpym` files.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `renpyLabelTool.scanRoots` | `["game"]` | Folders to scan, with workspace-root fallback. |
| `renpyLabelTool.excludeGlobs` | `["**/renpy/**", "**/node_modules/**", "**/python-packages/**", "**/cache/**", "**/saves/**"]` | Patterns excluded from the scan. |
| `renpyLabelTool.checkLabels` | `true` | Report missing label targets. |
| `renpyLabelTool.checkScreens` | `true` | Report missing screen targets. |
| `renpyLabelTool.checkExpressionStrings` | `true` | Validate string literal targets. |
| `renpyLabelTool.reportDynamicTargets` | `false` | Report runtime-computed targets. |
| `renpyLabelTool.ignoredLabels` | engine entry points | Labels never reported as missing. |
| `renpyLabelTool.ignoredScreens` | engine screens | Screens never reported as missing. |

## Building

Run `build-vsix.cmd` on Windows, or:

```
npx @vscode/vsce package --allow-missing-repository
```

Pushing a `v*` tag builds and publishes the VSIX through the GitHub Actions workflow in `.github/workflows/release-vsix.yml`.

## License

GPL-2.0-only. See `LICENSE.txt`.
