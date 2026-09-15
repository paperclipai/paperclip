import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { InlineEntitySelector, type InlineEntityOption } from "@/components/InlineEntitySelector";

const assignees: InlineEntityOption[] = [
  { id: "agent-product", label: "Product Lead", searchText: "planning product" },
  { id: "agent-engineer", label: "Frontend Engineer", searchText: "ui implementation" },
  { id: "agent-qa", label: "QA Engineer", searchText: "testing review" },
];

const projects: InlineEntityOption[] = [
  { id: "project-control-plane", label: "Control Plane" },
  { id: "project-mobile", label: "Mobile Experience" },
  { id: "project-connectors", label: "Apps and Connectors" },
];

function OpenPicker({ kind, options }: { kind: "Assignee" | "Project"; options: InlineEntityOption[] }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    triggerRef.current?.click();
  }, []);

  return (
    <div className="flex min-h-screen items-end p-4">
      <InlineEntitySelector
        ref={triggerRef}
        value={value}
        options={options}
        placeholder={`Choose ${kind.toLowerCase()}`}
        noneLabel={`No ${kind.toLowerCase()}`}
        searchPlaceholder={`Search ${kind.toLowerCase()}s...`}
        emptyMessage={`No matching ${kind.toLowerCase()}.`}
        onChange={setValue}
      />
    </div>
  );
}

const meta = {
  title: "Components/Entity pickers/Mobile",
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "mobile1" },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const AssigneePicker: Story = {
  render: () => <OpenPicker kind="Assignee" options={assignees} />,
};

export const ProjectPicker: Story = {
  render: () => <OpenPicker kind="Project" options={projects} />,
};
