---@meta
--- Definitions for the SAS package for Lua - the `sas` table PROC LUA puts in
--- scope, plus the `string`/`table` functions it adds. Nothing here executes:
--- src/emmylua-worker.js opens it as one more document in the language server,
--- purely so completion, hover and signature help know about an API no Lua
--- server can discover on its own.
---
--- Transcribed from the LuaDoc of the package SAS itself ships (the Lua source
--- embedded in SASFoundation/9.4/sasexe/sasplua), so the signatures and the
--- descriptions are the vendor's own, not guesses.
---
--- ponytail: the documented package API only. Every SAS DATA step function is
--- ALSO callable as `sas.<name>(...)` (sas.putn, sas.fileexist, sas.today, ...)
--- - a few of those are below where the package's own code relies on them, but
--- the full function list is thousands of entries and belongs in a generated
--- file if it is ever worth having.

---@class sas.varinfo
---@field name string Variable name
---@field type string `"C"` for character, `"N"` for numeric
---@field length integer Storage length
---@field label string
---@field format string Format name, without width or decimals
---@field fmt_width integer
---@field fmt_dec integer
---@field informat string
---@field infmt_width integer
---@field infmt_dec integer

--- A variable definition as accepted by `sas.new_dataset` / `dsid:add_vars`.
---@class sas.vardef
---@field name string
---@field type string `"C"` or `"N"`
---@field length integer
---@field label string
---@field format string

--- A data set id, as returned by `sas.open`. Every method below can also be
--- called in function form, `sas.<method>(dsid, ...)`.
---@class sas.dsid
local dsid = {}

--- Number of variables in the data set.
---@return integer
function dsid:nvars() end

--- Number of observations in the data set.
---@return integer
function dsid:nobs() end

--- Move to the next observation. False at end of data.
---@return boolean
function dsid:next() end

--- Rewind to before the first observation.
function dsid:rewind() end

--- Get a value from the current observation.
---@param variable string|integer Variable name or number
---@return string|number
function dsid:get_value(variable) end

--- Get a value from the current observation (short form of `get_value`).
---@param variable string|integer Variable name or number
---@return string|number
function dsid:get(variable) end

--- Get a formatted value from the current observation, by variable number.
---@param variable_index integer
---@return string
function dsid:getfvar(variable_index) end

--- Get a formatted value from the current observation, by variable name.
---@param variable_name string
---@return string
function dsid:getfvarbyname(variable_name) end

--- Load a single value into a variable of the current observation.
---@param variable string|integer Variable name or number
---@param value string|number
function dsid:put_value(variable, value) end

--- Write back the values loaded with `put_value`.
function dsid:update() end

--- Start a new observation, to be filled with `put_value` and written with
--- `update`.
function dsid:append() end

--- Mark the current observation for deletion.
function dsid:delobs() end

--- Add variables to the data set (the data set must be open for output).
---@param vars table<string, sas.vardef>
function dsid:add_vars(vars) end

--- Apply a where clause. Adds to an existing clause unless `replace_where` is
--- true; `"also <condition>"`, `"undo"` and `"clear"` are supported.
---@param where_clause string
---@param replace_where? boolean Defaults to true
---@return boolean rc, string? message
function dsid:where(where_clause, replace_where) end

--- Information about one variable.
---@param variable string|integer Variable name or number
---@return sas.varinfo
function dsid:varinfo(variable) end

--- Variable number of a named variable.
---@param name string
---@return integer
function dsid:varnum(name) end

--- Name of the variable at that index.
---@param index integer
---@return string
function dsid:varname(index) end

--- Storage length of a variable.
---@param variable string|integer
---@return integer
function dsid:varlen(variable) end

--- `"C"` for character, `"N"` for numeric.
---@param variable string|integer
---@return string
function dsid:vartype(variable) end

--- Label of a variable.
---@param variable string|integer
---@return string
function dsid:varlabel(variable) end

--- Value of a data set attribute, e.g. `dsid:get_attr("label")`.
---@param attr_name string
---@return any
function dsid:get_attr(attr_name) end

--- Set a data set attribute.
---@param attr_name string
---@param attr_value any
function dsid:set_attr(attr_name, attr_value) end

--- Iterate the variables of the data set.
---@return fun(): sas.varinfo
function dsid:vars() end

--- Iterate the observations, each as a table keyed by lower-cased column name
--- (and by column number).
---@return fun(): table
function dsid:rows() end

--- The format of a variable, width and decimals included.
---@param variable string|integer
---@return string
function dsid:varfmt(variable) end

--- The informat of a variable, width and decimals included.
---@param variable string|integer
---@return string
function dsid:varinfmt(variable) end

--- Close the data set.
function dsid:close() end

--- Every DATA step function is callable as `sas.<name>(...)` too - thousands of
--- them, so they are not listed here. The index signature is what keeps them
--- from reading as undefined fields; their real names and documentation come
--- from the SAS language server at completion/hover time (sasFunctions and
--- sasFnHover in src/editor-swap.js).
---@class saslib
---@field [string] fun(...): any
sas = {}

--- The SAS missing value.
sas.MISSING = nil

-- Data sets ------------------------------------------------------------------

--- Open a SAS data set.
---@param dataset string The fully qualified data set name
---@param mode? string `"I"` (input, the default), `"U"` (update), `"O"` (output) or `"V"`
---@return sas.dsid
function sas.open(dataset, mode) end

--- Close a data set.
---@param dsid sas.dsid
function sas.close(dsid) end

--- Iterate through the variables in a data set, for use in a generic `for`.
---
--- ```lua
--- for var in sas.vars(dsid) do vars[var.name:lower()] = var end
--- ```
---@param dsid sas.dsid
---@return fun(): sas.varinfo
function sas.vars(dsid) end

--- Iterate through the rows of a data set, for use in a generic `for`. Each
--- iteration returns a table with the row's data, indexed by column name.
---
--- ```lua
--- local dsid = sas.open('sashelp.class')
--- for row in sas.rows(dsid) do print(row.age, row.height) end
--- sas.close(dsid)
--- ```
---@param dsid sas.dsid
---@return fun(): table
function sas.rows(dsid) end

--- Move to the next observation.
---@param dsid sas.dsid
---@return boolean
function sas.next(dsid) end

--- Get a value from the current observation.
---@param dsid sas.dsid
---@param variable string|integer Variable name or number
---@return string|number
function sas.get_value(dsid, variable) end

--- Load a single value into a variable of the current observation.
---@param dsid sas.dsid
---@param variable string|integer
---@param value string|number
function sas.put_value(dsid, variable, value) end

--- Write back the values loaded with `put_value`.
---@param dsid sas.dsid
function sas.update(dsid) end

--- Start a new observation.
---@param dsid sas.dsid
function sas.append(dsid) end

--- Add variables to a data set.
---@param dsid sas.dsid
---@param vars table<string, sas.vardef>
function sas.add_vars(dsid, vars) end

--- Number of variables in a data set.
---@param dsid sas.dsid
---@return integer
function sas.nvars(dsid) end

--- Number of observations in a data set.
---@param dsid sas.dsid
---@return integer
function sas.nobs(dsid) end

--- Information about one variable.
---@param dsid sas.dsid
---@param variable string|integer Variable name or number
---@return sas.varinfo
function sas.varinfo(dsid, variable) end

--- The SAS format of a variable, width and decimals included.
---@param dsid sas.dsid
---@param variable string|integer
---@return string
function sas.varfmt(dsid, variable) end

--- The SAS informat of a variable, width and decimals included.
---@param dsid sas.dsid
---@param variable string|integer
---@return string
function sas.varinfmt(dsid, variable) end

--- Apply a where clause to a data set.
---@param dsid sas.dsid
---@param where_clause string
---@param replace_where? boolean Defaults to true
---@return boolean rc, string? message
function sas.where(dsid, where_clause, replace_where) end

--- Value of a data set attribute, e.g. `sas.get_attr(dsid, "label")`.
---@param dsid sas.dsid
---@param attr_name string
---@return any
function sas.get_attr(dsid, attr_name) end

--- Set a data set attribute.
---@param dsid sas.dsid
---@param attr_name string
---@param attr_value any
function sas.set_attr(dsid, attr_name, attr_value) end

--- Create an empty data set with specific variables.
---
--- ```lua
--- sas.new_dataset("work.foo", {
---    country = { length = 45, name = "Country", type = "C", label = "Country of Origin" },
---    weight  = { format = "best8.", type = "N" },
--- })
--- ```
---@param dsname string The fully qualified data set name
---@param vars table<string, sas.vardef>
function sas.new_dataset(dsname, vars) end

--- Create an empty data set with specific variables. Same as `new_dataset`.
---@param dsname string
---@param vars table<string, sas.vardef>
function sas.new_table(dsname, vars) end

--- Read a data set into a Lua table: an array of rows, plus `name`, `vars`
--- (a `sas.varinfo` per lower-cased column name) and `nvars`.
---
--- ```lua
--- local fish = sas.read_ds("sashelp.fish")
--- ```
---@param dsname string The fully qualified data set name
---@return table
function sas.read_ds(dsname) end

--- Read a data set into a Lua table. Same as `read_ds`.
---@param dsname string
---@return table
function sas.load_ds(dsname) end

--- Write a Lua table (an array of rows) out as a data set. Column definitions
--- are taken from the table's `vars` entry when it has one, otherwise inferred
--- from its first row.
---@param atable table
---@param dsname? string Defaults to `atable.name`
function sas.write_ds(atable, dsname) end

--- Check for the existence of a data set. Wraps the SAS `exist()` function.
---@param dsname string The fully qualified data set name
---@param type? string Space delimited, e.g. `"DATA VIEW"`; `"ALL"` means `"DATA VIEW CATALOG"`
---@return boolean
function sas.exists(dsname, type) end

--- The SAS `exist()` function: 1 when the member exists, 0 when it does not.
---@param dsname string
---@param type? string
---@return integer
function sas.exist(dsname, type) end

--- Lock a data set.
---@param dsname string
function sas.lock_ds(dsname) end

--- Release a lock taken with `lock_ds`.
---@param dsname string
function sas.unlock_ds(dsname) end

--- Members of a library, as a list of `{ member = ..., type = ... }` tables -
--- or, with `simple` true and a `type` given, a plain list of member names.
---@param library string An existing SAS library
---@param type? string Space delimited, e.g. `"DATA VIEW"`; `"ALL"` is the default
---@param simple? boolean Produce a simple list of member names
---@return table
function sas.memlist(library, type, simple) end

-- Submitting SAS code --------------------------------------------------------

--- Submit SAS code, one step at a time: the code is split at each `run;` or
--- `quit;` and submission stops at the first step whose SYSERR exceeds
--- `max_allowed_syserr`. Write `run ;` to keep a step from being split off.
--- Tokens of the form `@name@` in the code are substituted from `args`, then
--- from the caller's local variables.
---
--- ```lua
--- local code = "data @out@; set @in@; where @where@; run;"
--- sas.submit(code, { out = "work.foo", ["in"] = "bar", where = "x > 2" })
--- ```
---@param code string The code to submit
---@param args? table Token/value pairs for the substitution
---@param additional_level? integer How far back in the stack to look for token variables
---@param max_allowed_syserr? integer Defaults to 0, so any error throws
---@return integer syserr SYSERR from the SAS run
function sas.submit(code, args, additional_level, max_allowed_syserr) end

--- Submit SAS code without an implied `run;` - supply your own, or use
--- `sas.submit`.
---@param code string
---@param args? table
---@param additional_level? integer
function sas.submit_(code, args, additional_level) end

--- Turn echoing of submitted code to the SAS log on and off.
---@param flag boolean True turns echoing off
---@return boolean
function sas.set_quiet(flag) end

--- Whether submitted code is echoed to the SAS log.
---@return boolean
function sas.is_quiet() end

--- Highest SYSERR `sas.submit` accepts without throwing.
---@param max_syserr integer
function sas.set_max_syserr(max_syserr) end

---@return integer
function sas.get_max_syserr() end

--- Set the token separator used by `sas.submit` and `string.resolve`
--- (`"@"` by default; `"$"` switches to `$name` tokens).
---@param sep string
---@return boolean
function sas.set_separator(sep) end

-- Macro variables, options, librefs -------------------------------------------

--- Value of a macro variable.
---@param name string
---@return string
function sas.symget(name) end

--- Numeric value of a macro variable.
---@param name string
---@return number
function sas.symgetn(name) end

--- Set a macro variable in the current scope.
---@param name string
---@param value string|number
function sas.symput(name, value) end

--- Set a macro variable in the global scope.
---@param name string
---@param value string|number
function sas.gsymput(name, value) end

--- Assign or clear a libref. Wraps the SAS `libname()` function.
---@param libref string
---@param path? string Clears the libref when omitted
---@param engine? string
---@param options? string
---@return integer rc 0 on success
function sas.libname(libref, path, engine, options) end

--- Assign a libref in the global scope.
---@param libref string
---@param path? string
---@param engine? string
---@param options? string
---@return integer rc
function sas.glibname(libref, path, engine, options) end

--- Assign a fileref in the global scope.
---@param fileref string
---@param path? string
---@param device? string
---@param options? string
---@return integer rc
function sas.gfilename(fileref, path, device, options) end

--- Value of a SAS option, with its natural type. Returns nil and a message
--- when the option is unknown.
---
--- ```lua
--- print(sas.get_option("notes"))
--- ```
---@param option_name string
---@return any value, string? message
function sas.get_option(option_name) end

--- Value of a SAS option. Same as `get_option`.
---@param option_name string
---@return any value, string? message
function sas.getoption(option_name) end

--- Set a SAS option for the code run during this Lua session.
---@param option_name string
---@param value any Must have the option's own type
function sas.set_option(option_name, value) end

--- Set a SAS option. Same as `set_option`.
---@param option_name string
---@param value any
function sas.setoption(option_name, value) end

-- Values, files, misc ---------------------------------------------------------

--- Format a message onto the SAS log through SAS's own print functions, so it
--- gets the right colour and does substitutions.
---
--- ```lua
--- sas.print("%2zThis shows up as a warning and %s", "does substitutions")
--- ```
---@param format string
---@param ... any
function sas.print(format, ...) end

--- Format a value: PUTN or PUTC, by the type of `value`.
---@param value string|number
---@param format string The SAS format
---@return string
function sas.put(value, format) end

--- Format a numeric value with a SAS format.
---@param value number
---@param format string
---@return string
function sas.putn(value, format) end

--- Format a character value with a SAS format.
---@param value string
---@param format string
---@return string
function sas.putc(value, format) end

--- Whether a value is a SAS missing value.
---@param value any
---@return boolean
function sas.is_missing(value) end

--- Check for the existence of a file. Wraps the SAS `fileexist()` function.
---@param filename string The fully qualified filename
---@return boolean
function sas.fileexists(filename) end

--- The SAS `fileexist()` function: 1 when the file exists, 0 when it does not.
---@param filename string
---@return integer
function sas.fileexist(filename) end

--- Delete a file.
---@param filename string
---@return integer rc
function sas.delete(filename) end

--- Seed the SAS random number streams.
---@param seed integer
function sas.streaminit(seed) end

--- Sleep for `amount` units of `unit` seconds.
---@param amount number
---@param unit? number Defaults to 1 (seconds)
function sas.sleep(amount, unit) end

--- Sleep the specified number of milliseconds.
---@param amount number
function sas.sleep_millis(amount) end

--- Parse an XML string into a Lua table. The document can be traversed with dot
--- notation, attributes prefixed with `@`:
---
--- ```lua
--- print(doc.applications.application.analysis.stp[2]["@name"])
--- ```
---@param xml_string string
---@return table
function sas.xml_parse(xml_string) end

--- Convert a table in the form `sas.xml_parse` returns back into XML.
---@param table table
---@return string
function sas.to_xml(table) end

--- End the Lua session.
function sas.exit() end

-- Additions to the standard library -------------------------------------------

--- Substitute `@name@` tokens in a string, from `args` and from the caller's
--- local variables. The same substitution `sas.submit` does.
---
--- ```lua
--- local code = string.resolve("data @out@; set @in@; run;", { out = "work.foo", ["in"] = "bar" })
--- ```
---@param str string
---@param args? table Token/value pairs
---@param level? integer How far up the stack to look for token variables
---@return string
function string.resolve(str, args, level) end

--- Whether `str` ends with `suffix`. Case sensitive.
---@param str string
---@param suffix string
---@return boolean
function string.ends_with(str, suffix) end

--- Whether `str` starts with `prefix`. Case sensitive.
---@param str string
---@param prefix string
---@return boolean
function string.starts_with(str, prefix) end

--- Trim whitespace from both ends of a string.
---@param str string
---@return string
function string.trim(str) end

--- Split a string on a separator. Empty substrings are dropped unless asked
--- for.
---@param str string
---@param by string The separator
---@param remove_empty_strings? boolean Defaults to true
---@return string[]
function string.split(str, by, remove_empty_strings) end

--- Search a table for a value.
---@param a_table table
---@param value any
---@return boolean found, any key
function table.contains(a_table, value) end

--- Number of elements in a table. For arrays `#t` is faster.
---@param a_table table
---@return integer
function table.size(a_table) end

--- String representation of a table, nested tables included.
---@param obj table
---@return string
function table.tostring(obj) end
