import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  type ReactNode,
} from "react";
import type { AdapterConfigSection } from "./types";

/** Partition declarative adapter fields without coupling placement to visible labels. */
export function configFieldsForSection(
  section: AdapterConfigSection | undefined,
  children: ReactNode,
): ReactNode {
  if (!section) return children;
  return Children.map(children, (child) => {
    if (
      !isValidElement<{
        children?: ReactNode;
        configSection?: AdapterConfigSection;
      }>(child)
    )
      return null;
    if (child.type === Fragment)
      return cloneElement(
        child,
        undefined,
        configFieldsForSection(section, child.props.children),
      );
    return (child.props.configSection ?? "configuration") === section
      ? child
      : null;
  });
}

export function schemaFieldSection(key: string): AdapterConfigSection {
  if (["model", "provider"].includes(key)) return "adapter";
  if (["command", "agentCommand", "args", "extraArgs"].includes(key))
    return "advanced";
  if (["env", "envVars", "environmentVariables"].includes(key))
    return "environment";
  if (
    /timeout|grace|lifecycle/i.test(key) ||
    [
      "lifecycleMode",
      "mode",
      "sessionMode",
      "persistSession",
      "sessionKeyStrategy",
      "warmHandleIdleMs",
    ].includes(key)
  )
    return "runPolicy";
  return "configuration";
}
