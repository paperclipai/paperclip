# Product proposal: Epics, human work, AI execution, and context-sized cycles

Date: 2026-08-26
Status: candidate implementation validated on staging; richer Epic-to-task linkage remains follow-up

## Intent

Make the work model explicit:

- An **Epic** is a large, changing outcome or body of work. It is a planning and acceptance container, not a task.
- A **human task** is work that must be performed, reviewed, clarified, or accepted by a person. It cannot be delegated to an AI agent.
- An **AI execution task** is an implementation/trial-and-error task that may be delegated to an agent to satisfy acceptance criteria.
- A **cycle** is a context-sized delivery window. It may last two days, four days, seven days, or another deliberate duration; it is not assumed to be a one-week sprint.

## Current-state gap

The data model already has useful pieces: `parentId`, `cycleId`, `workItemType`, human/agent assignee fields, review policy, and execution policy. The UI previously called the large container an “Initiative” and offered only partial type separation through Work Hub filters. It did not make the Epic → acceptance task → AI execution relationship obvious enough, nor did it make the human-only boundary and closure gate explicit.

## Implemented first slice

- Existing `initiative` records are labeled **Epic** in the sidebar, Work Hub, project lanes, and issue badges without breaking stored data or routes.
- New issue creation exposes an explicit Work type selector for Epic, Human task, and AI execution, with a short explanation for each choice.
- AI execution items have a distinct list badge; human control items continue to hide agent assignment controls.
- The server now rejects an AI-agent assignee when creating or updating an Epic or human task, keeping the human-only boundary authoritative outside the UI as well.
- Epics, human tasks, and AI execution tasks can carry structured acceptance criteria with pending, passed, or failed state.
- Board-controlled criteria are shown in issue properties; an agent cannot rewrite criteria on an Epic or human task.
- The service refuses to close an issue while any criterion is pending/failed, and refuses to close an Epic while direct child work remains open.
- Agents receive the work-item type and current criteria in their task context, so AI execution can iterate against the same definition of done.
- The Epics view now has a canonical `/epics` URL (the old `/initiatives` URL remains compatible), and cycle creation offers 1-, 2-, 4-, and 7-day presets while retaining editable dates.

## Proposed model

Use this hierarchy:

```text
Epic
├── Human task: define or verify acceptance criteria
├── AI execution task: implement, test, and iterate
└── Human task: final acceptance / release decision
```

An Epic may have child human tasks and AI execution tasks. An AI execution task can reference the acceptance task(s) it is trying to satisfy. The Epic cannot be closed while required acceptance tasks are incomplete or rejected.

For compatibility, existing stored `initiative` rows should continue to load while the user-facing label changes to “Epic”. A later migration can introduce a canonical `epic` value if that is worth the compatibility cost.

## UX requirements

- Rename the Work navigation item from “Initiatives” to “Epics”.
- Add a clear creation choice: Epic, Human task, or AI execution task.
- Show badges for item kind and owner: `Epic`, `Human task`, `AI execution`.
- Human tasks expose a person/reviewer and acceptance criteria; agent assignment is rejected or hidden.
- AI execution tasks expose agent assignment, execution policy, workspace, model lane, and a link to the acceptance criteria they serve.
- Epic detail shows child work grouped into acceptance, human, and AI execution lanes, with a closure-readiness summary.
- Cycle creation asks for an intentional start/end date or duration and displays the resulting window; no one-week default is implied.
- Cycle views show Epic containers separately from executable work and allow human and AI tasks to be moved independently.

## Acceptance criteria

1. A user can create an Epic without assigning an agent or treating it as executable work. *(First-slice UI and API boundary implemented.)*
2. A user can create a human-only task and the API/UI prevent it from being delegated to an AI agent. *(Implemented.)*
3. A user can create an AI execution task under an Epic and assign it to an agent. *(Existing parent/assignee support; end-to-end UX linkage remains.)*
4. A human acceptance task can define pass/fail criteria and remain open after an AI execution task reports completion. *(Structured criteria and independent work-item status implemented and browser-validated on staging.)*
5. Closing an Epic is blocked or clearly warned when required acceptance tasks are incomplete or failed. *(Service gate blocks open children and any unpassed criteria; browser-validated on staging.)*
6. Reports and Work Hub counts distinguish Epics, human tasks, and AI execution tasks. *(Labels, filters, badges, and dashboard copy updated.)*
7. A cycle supports deliberate durations including 1, 2, 4, and 7 days without assuming a weekly sprint. *(Presets implemented and browser-validated on staging.)*
8. Existing `initiative`, `human_task`, and `ai_task` records remain readable during rollout.
9. API, shared types, database constraints, UI labels, filters, and tests stay synchronized.

## Suggested delivery slices

1. Terminology and compatibility layer: display “Epic” for existing initiatives; add the creation selector and tests. *(Implemented.)*
2. Human-only enforcement: assignment validation, acceptance criteria, and review/closure behavior. *(Implemented in candidate.)*
3. AI execution linkage: parent Epic/acceptance references, execution affordances, and status reporting. *(Criteria are persisted and included in agent context; richer cross-linking remains follow-up.)*
4. Epic detail and closure readiness. *(Direct-child progress and service-level closure gate implemented; richer lane grouping remains follow-up.)*
5. Cycle duration UX and Epic/task reporting. *(Implemented and browser-validated in candidate.)*
