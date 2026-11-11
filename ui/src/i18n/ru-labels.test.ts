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

  it("keeps every Russian value non-empty and free of markup", () => {
    for (const [key, value] of Object.entries(ruLabels)) {
      expect(key.length).toBeGreaterThan(0);
      expect(value.trim().length).toBeGreaterThan(0);
      expect(value).not.toBe(key);
      expect(value).not.toMatch(/[<>]|javascript:/i);
    }
  });
});
