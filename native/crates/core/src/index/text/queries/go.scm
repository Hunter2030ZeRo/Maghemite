(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_spec name: (type_identifier) @name) @definition.type
(type_alias name: (type_identifier) @name) @definition.type
; The grammar wraps the comma-separated const names in a single field.
; Direct identifier children cover every name and exclude the value expression.
(const_spec (identifier) @name) @definition.constant
(var_spec name: (identifier) @name) @definition.variable
(short_var_declaration left: (expression_list) @binding) @definition.variable
(field_declaration name: (field_identifier) @name) @definition.field
(method_elem name: (field_identifier) @name) @definition.method
