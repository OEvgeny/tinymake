# tinymake.js

A tiny GNU Makefile subset runner for JS runtimes.

> Why? Not all task runners scale gracefully. GNU Make does, and LLMs understand Makefiles very well.

## Supported

- variables:
  - `NAME = value`
  - `NAME := value`
  - `NAME ?= value`
- exported variables:
  - `export NAME = value`
  - `export NAME := value`
  - `export NAME ?= value`
  - `export NAME`
  - `export NAME OTHER_NAME`
- `.PHONY`
- plain target rules
- dependencies
- tab-indented recipe lines
- inline recipe form: `target: deps ; command`
- multiple targets in one rule
- backslash line continuation at the end of a physical line
- variable references:
  - `$(NAME)`
  - `${NAME}`
- automatic recipe variables:
  - `$@` current target
  - `$<` first dependency
  - `$^` unique dependencies joined by spaces
- supported functions:
  - `$(realpath path...)`
  - `$(wildcard pattern...)`
  - `$(notdir names...)`
  - `$(dir names...)`
- command prefixes:
  - `@` do not echo the command
  - `-` ignore non-zero exit code
  - `+` accepted and ignored
- CLI variable overrides like `NAME=value`
- `-f FILE`
- `-n` / `--dry-run`
- `-h` / `--help`
- default target selection from the first non-dot rule target

## Not supported

- `include`
- `define` / multi-line macros
- pattern rules / implicit rules
- suffix rules
- conditionals like `ifeq`
- target-specific variables
- automatic dependency generation
- functions other than `realpath`, `wildcard`, `notdir` and `dir` (other GNU Make functions fail the run instead of expanding to an empty string)
- `$(shell ...)`
- timestamp-based rebuild checks
- exact GNU Make parsing and escaping edge cases
- full GNU Make compatibility

## Behavior

- dependencies are executed depth-first
- a target runs at most once per invocation
- if a prerequisite has no rule but exists as a file, it is accepted
- recipe lines run in separate shell processes, like GNU Make
- rules with recipes run when requested; there is no file freshness logic
- circular dependencies are detected and fail the run
- duplicate recipe-bearing rules for the same target are rejected
- only exported variables are injected into the child process environment
- non-exported variables still expand inside recipes through `$(NAME)` / `${NAME}`

## Usage

```bash
node tinymake.js [options] [VAR=value ...] [target ...]
bun tinymake.js [options] [VAR=value ...] [target ...]
deno -A tinymake.js [options] [VAR=value ...] [target ...]
````

Examples:

```bash
node tinymake.js
node tinymake.js all
node tinymake.js -f Build.mk release
node tinymake.js NAME=world hello
node tinymake.js -n deploy
```

## Example Makefile

```make
export PATH := $(realpath ../node_modules/.bin):$(PATH)
NAME ?= world
OUT := dist
ASSETS := $(wildcard public/*.html) public/assets

.PHONY: all hello clean

all: hello build

hello:
	@echo Hello, $(NAME)

$(OUT):
	mkdir -p $(OUT)

build: $(OUT) src/index.js $(ASSETS)
	echo target=$@
	echo first=$<
	echo deps=$^
	node src/index.js > $(OUT)/app.txt

clean:
	rm -rf $(OUT)
```

## Exit behavior

* parse errors exit with code `1`
* runtime errors like missing rules or circular dependencies exit with code `1`
* command failures exit with the child command status unless the line starts with `-`
