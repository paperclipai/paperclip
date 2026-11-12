import { describe, expect, it } from "vitest";

import { ruLabels } from "./ru-labels";
import { translateLabel } from "./tx";

describe("translateLabel", () => {
  it("returns the English string unless the language is Russian", () => {
    expect(translateLabel("en", "New Task")).toBe("New Task");
    expect(translateLabel(undefined, "Dashboard")).toBe("Dashboard");
    expect(translateLabel("ru", "  Cancel\n")).toBe("Отменить");
  });

  it("uses the board vocabulary", () => {
    expect(translateLabel("ru", "Dashboard")).toBe("Обзор");
    expect(translateLabel("ru", "New Task")).toBe("Новая задача");
    expect(translateLabel("ru", "Routines")).toBe("Регламенты");
    expect(translateLabel("ru", "Harness")).toBe("CLI-агент");
    expect(translateLabel("ru", "Assignee")).toBe("Исполнитель");
    expect(translateLabel("ru", "Runner")).toBe("Раннер");
    expect(translateLabel("ru", "Connectors")).toBe("Сервисы");
    expect(translateLabel("ru", "Connections")).toBe("Подключения");
    expect(translateLabel("ru", "idle")).toBe("свободен");
    expect(translateLabel("ru", "In progress")).toBe("В работе");
    expect(translateLabel("ru", "In Progress")).toBe("В работе");
    expect(translateLabel("ru", "In Review")).toBe("На проверке");
    expect(translateLabel("ru", "Title")).toBe("Название");
    expect(translateLabel("ru", "Agent is not invokable in its current state")).toBe(
      "Агента нельзя запустить в текущем состоянии.",
    );
    expect(translateLabel("ru", "Couldn’t finish this attempt. Your message is saved.")).toBe(
      "Не удалось завершить эту попытку. Сообщение сохранено.",
    );
    expect(translateLabel("ru", "Thinking")).toBe("Думает");
    expect(translateLabel("ru", "Thinking effort")).toBe("Глубина рассуждения");
    expect(translateLabel("ru", "Live")).toBe("Сейчас");
    expect(translateLabel("ru", "just now")).toBe("только что");
    expect(translateLabel("ru", "Today")).toBe("Сегодня");
    expect(translateLabel("ru", "Describe a task…")).toBe("Опишите задачу…");
    expect(translateLabel("ru", "Project")).toBe("Проект");
    expect(translateLabel("ru", "See all agents")).toBe("Все агенты");
    expect(translateLabel("ru", "Settings")).toBe("Настройки");
    expect(translateLabel("ru", "Invite")).toBe("Пригласить");
    expect(translateLabel("ru", "Documentation")).toBe("Документация");
    expect(translateLabel("ru", "Switch to light mode")).toBe("Светлая тема");
    expect(translateLabel("ru", "Switch to dark mode")).toBe("Тёмная тема");
    expect(translateLabel("ru", "Sign out")).toBe("Выйти");
    expect(translateLabel("ru", "No project")).toBe("Без проекта");
    expect(translateLabel("ru", "Select project")).toBe("Выберите проект");
    expect(translateLabel("ru", "Search projects...")).toBe("Поиск проектов…");
    expect(translateLabel("ru", "No projects found.")).toBe("Проекты не найдены.");
    expect(translateLabel("ru", "Yesterday")).toBe("Вчера");
    expect(translateLabel("ru", "Earlier")).toBe("Ранее");
    expect(translateLabel("ru", "Paperclip")).toBe("Paperclip");
    expect(translateLabel("ru", "A task title")).toBe("A task title");
  });

  it("translates member and instance access labels", () => {
    const keys = [
      "Viewer",
      "Can view organization work and follow along.",
      "Operator",
      "Can edit organization work and invite people.",
      "Full editing and audit access. Cannot approve join requests or manage member permissions.",
      "Admin",
      "Recommended for operators who need to invite people, create agents, and approve joins.",
      "Can create agents, invite users, assign tasks, and approve join requests.",
      "Full organization access, including membership management.",
      "Everything in Admin, plus managing members.",
      "Clipboard unavailable",
      "The invite URL is selected. Copy it manually from the field.",
      "Copy the invite URL manually from the field below.",
      "Invite created",
      "Invite ready below.",
      "Failed to create invite",
      "Invite revoked",
      "Failed to revoke invite",
      "Loading invites…",
      "You do not have permission to manage organization invites.",
      "Invite people to request access to this organization. New invite links are copied to your clipboard when they are generated.",
      "Invite a person",
      "Generate a human invite link and choose the default access it should request.",
      "Choose a role",
      "Each invite link is single-use. Human invitees get the selected role immediately after sign-in; agent invites still create a join request for approval.",
      "Create invite",
      "Invite history below keeps the audit trail.",
      "Latest invite link",
      "Copied",
      "This URL includes the current Paperclip domain returned by the server.",
      "Copy link",
      "Invite history",
      "Review invite status, audience, inviter, and any linked join request.",
      "Open join request queue",
      "No invites have been created for this organization yet.",
      "For",
      "Invited by",
      "Join request",
      "Review request",
      "Revoke",
      "View more",
      "Select an organization to manage invites.",
      "Human or agent",
      "Member updated",
      "Failed to update member",
      "Join request approved",
      "Failed to approve join request",
      "Join request rejected",
      "Failed to reject join request",
      "Member removed",
      "Failed to remove member",
      "Select an organization to manage access.",
      "Loading organization access…",
      "You do not have permission to manage organization members.",
      "Organization Members",
      "This account can manage access here through instance-admin privileges, but it does not currently hold an active organization membership.",
      "Pending human joins",
      "Review pending join requests before they become active organization members.",
      "Invite metadata unavailable",
      "Approve human",
      "Reject human",
      "No user memberships found for this organization yet.",
      "Unset",
      "Edit member",
      "Update organization role and membership status for",
      "Organization role",
      "Membership status",
      "Suspended",
      "Save member",
      "Remove member",
      "Task reassignment",
      "Leave unassigned",
      "Humans",
      "Checking for advanced permission extensions...",
      "Advanced Permissions",
      "Advanced access, scoped assignment, and explicit grant controls are provided by installed organization settings extensions.",
      "Advanced permissions unavailable",
      "Core Paperclip keeps enforcing organization boundaries and any existing restrictive policy data, but editing advanced permissions requires an installed extension.",
      "Plugin extensions unavailable:",
      "Open Members",
      "Open Invites",
      "Instance settings",
      "Organization access updated",
      "No user selected",
      "Instance role updated",
      "Loading instance access…",
      "Instance admin access is required to manage users.",
      "Instance Access",
      "Search users, manage instance-admin status, and control which organizations they can access.",
      "Search users",
      "Search by name or email",
      "Loading user access…",
      "Promote to instance admin",
      "Organization access",
      "Toggle organization membership for this user. New access defaults to an active operator membership.",
      "Save organization access",
      "Current memberships",
      "Select a user to inspect instance access.",
    ];
    expect(keys).toHaveLength(98);
    for (const key of keys) {
      expect(ruLabels[key], key).toEqual(expect.any(String));
      expect(translateLabel("ru", key)).toBe(ruLabels[key]);
      expect(translateLabel("en", key)).toBe(key);
    }
    const prefix = "Update organization role and membership status for";
    expect(translateLabel("ru", `${prefix} `)).toBe(ruLabels[prefix]);
    expect(`${translateLabel("ru", prefix)} Codex Coder.`).toBe(
      "Обновите роль в компании и статус участия для Codex Coder.",
    );
  });

  it("keeps every Russian value non-empty and free of markup", () => {
    for (const [key, value] of Object.entries(ruLabels)) {
      expect(key.length).toBeGreaterThan(0);
      expect(value.trim().length).toBeGreaterThan(0);
      expect(value).not.toBe(key);
      expect(value).not.toMatch(/[<>]|javascript:/i);
    }
  });
});
