(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(function_expression name: (identifier) @name) @definition.function
(generator_function name: (identifier) @name) @definition.function
(class_declaration name: (_) @name) @definition.class
(class name: (_) @name) @definition.class
(method_definition name: [(property_identifier) (private_property_identifier) (string) (number)] @name) @definition.method
(variable_declarator name: (_) @binding) @definition.variable
(pair key: (property_identifier) @name value: [(arrow_function) (function_expression) (generator_function)]) @definition.function
