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
  allowedConfigKeys?: ReadonlySet<string>,
): ReactNode {
  if (!section && !allowedConfigKeys) return children;
  return Children.map(children, (child) => {
    if (
      !isValidElement<{
        children?: ReactNode;
        configSection?: AdapterConfigSection;
        configKey?: string;
      }>(child)
    )
      return null;
    if (child.type === Fragment)
      return cloneElement(
        child,
        undefined,
        configFieldsForSection(section, child.props.children, allowedConfigKeys),
      );
    if (allowedConfigKeys && (!child.props.configKey || !allowedConfigKeys.has(child.props.configKey))) return null;
    return (!section || (child.props.configSection ?? "configuration") === section)
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

/** Attach configuration identity to explanatory content without adding layout. */
export function ConfigFieldGroup({ children }: { configKey: string; children: ReactNode }) {
  return <>{children}</>;
}
