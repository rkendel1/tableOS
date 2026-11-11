/**
 * stack-ui's TextField and Select default their control id to `stack-field-<name>`, so two fields
 * without a `name` share one id and their labels point at the wrong control. These wrappers give
 * every instance a unique id (React useId) unless one is passed.
 */
import { useId } from "react";
import { Select as StackSelect, TextField as StackTextField, type SelectProps, type TextFieldProps } from "@stack-ui/react";

export function TextField(props: TextFieldProps) {
  const id = useId();
  return <StackTextField id={props.id ?? `f${id.replace(/:/g, "")}`} {...props} />;
}

export function Select(props: SelectProps) {
  const id = useId();
  return <StackSelect id={props.id ?? `f${id.replace(/:/g, "")}`} {...props} />;
}
