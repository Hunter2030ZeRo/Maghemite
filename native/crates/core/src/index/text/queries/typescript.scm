(function_signature name: (identifier) @name) @definition.function
(method_signature name: [(property_identifier) (private_property_identifier) (string) (number)] @name) @definition.method
(abstract_method_signature name: [(property_identifier) (private_property_identifier) (string) (number)] @name) @definition.method
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(enum_assignment name: (_) @name) @definition.enum_member
(enum_body name: (_) @name @definition.enum_member)
(internal_module name: (_) @name) @definition.module
(module name: (_) @name) @definition.module
(public_field_definition name: [(property_identifier) (private_property_identifier) (string) (number)] @name) @definition.field
(property_signature name: [(property_identifier) (private_property_identifier) (string) (number)] @name) @definition.field
