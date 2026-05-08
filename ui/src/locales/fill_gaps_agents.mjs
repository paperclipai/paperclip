// One-time script: fill agents.json config_form gaps for el/es/pt/uk/zh
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
      result[key] = deepMerge(typeof result[key] === 'object' && result[key] !== null ? result[key] : {}, source[key]);
    } else if (!(key in result)) {
      result[key] = source[key];
    }
  }
  return result;
}

function fill(locale, filename, patch) {
  const path = join(__dirname, locale, filename);
  const existing = JSON.parse(readFileSync(path, 'utf8'));
  const merged = deepMerge(existing, patch);
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log(`✓ ${locale}/${filename}`);
}

const AGENTS_CONFIG_FORM_PATCHES = {
  el: {
    config_form: {
      section_execution: "Εκτέλεση",
      experimental_badge: "Πειραματικό",
      primary_model: "Κύριο μοντέλο",
      fields: {
        default_environment: "Προεπιλεγμένο περιβάλλον",
        default_environment_hint: "Προεπιλεγμένος στόχος εκτέλεσης σε επίπεδο πράκτορα. Οι ρυθμίσεις έργου και εργασίας μπορούν να το παρακάμψουν.",
        default_environment_company_local: "Προεπιλογή εταιρίας (τοπικό)",
        continue_after_max_turn: "Συνέχεια μετά τη διακοπή ορίου βημάτων",
        continuation_attempts: "Προσπάθειες συνέχισης",
        continuation_delay_sec: "Καθυστέρηση συνέχισης (δευτ.)",
        unit_sec: "δευτ."
      },
      options: {
        auto: "Αυτόματο",
        minimal: "Ελάχιστο",
        low: "Χαμηλό",
        medium: "Μεσαίο",
        high: "Υψηλό",
        xhigh: "Πολύ υψηλό",
        plan: "Σχέδιο",
        ask: "Ρώτηση",
        max: "Μέγιστο"
      },
      actions: {
        test: "Δοκιμή",
        refresh_models: "Ανανέωση μοντέλων",
        refreshing: "Ανανέωση..."
      },
      errors: {
        select_company_secrets: "Επιλέξτε εταιρία για δημιουργία μυστικών",
        select_company_images: "Επιλέξτε εταιρία για μεταφόρτωση εικόνων",
        select_company_detect_model: "Επιλέξτε εταιρία για ανίχνευση μοντέλου",
        select_company_test_environment: "Επιλέξτε εταιρία για δοκιμή περιβάλλοντος προσαρμογέα",
        failed_refresh_models: "Αποτυχία ανανέωσης μοντέλων προσαρμογέα."
      },
      status: {
        live_opencode_local_only: "Η ζωντανή ανίχνευση μοντέλων OpenCode λειτουργεί μόνο για τοπικά περιβάλλοντα. Χρησιμοποιείται επιμελημένη λίστα και χειροκίνητη εισαγωγή για το {{name}}."
      },
      cheap_model: {
        label: "Οικονομικό μοντέλο",
        description: "Χρησιμοποιείται όταν μια εκτέλεση ζητά οικονομικό προφίλ (π.χ. συνοπτικές ρουτίνες). Το κύριο μοντέλο δεν αλλάζει.",
        adapter_default_placeholder: "Προεπιλογή προσαρμογέα · {{model}}",
        no_default_placeholder: "Δεν υπάρχει προεπιλογή προσαρμογέα — επιλέξτε φθηνότερο μοντέλο",
        fallback_note: "Δεν έχει επιλεγεί ρητά οικονομικό μοντέλο — το runtime χρησιμοποιεί <code>{{model}}</code>.",
        no_default_warning: "Δεν έχει επιλεγεί οικονομικό μοντέλο και ο προσαρμογέας δεν έχει προεπιλογή. Οι εκτελέσεις οικονομικού καναλιού θα συνεχίσουν με το κύριο μοντέλο με σημείωση fallback."
      }
    }
  },
  es: {
    config_form: {
      section_execution: "Ejecución",
      experimental_badge: "Experimental",
      primary_model: "Modelo principal",
      fields: {
        default_environment: "Entorno predeterminado",
        default_environment_hint: "Objetivo de ejecución predeterminado a nivel de agente. La configuración del proyecto y la tarea pueden anularlo.",
        default_environment_company_local: "Predeterminado de empresa (local)",
        continue_after_max_turn: "Continuar tras parar por límite de pasos",
        continuation_attempts: "Intentos de continuación",
        continuation_delay_sec: "Retardo de continuación (seg)",
        unit_sec: "seg"
      },
      options: {
        auto: "Auto",
        minimal: "Mínimo",
        low: "Bajo",
        medium: "Medio",
        high: "Alto",
        xhigh: "Muy alto",
        plan: "Plan",
        ask: "Preguntar",
        max: "Máximo"
      },
      actions: {
        test: "Probar",
        refresh_models: "Actualizar modelos",
        refreshing: "Actualizando..."
      },
      errors: {
        select_company_secrets: "Selecciona una empresa para crear secretos",
        select_company_images: "Selecciona una empresa para subir imágenes",
        select_company_detect_model: "Selecciona una empresa para detectar el modelo",
        select_company_test_environment: "Selecciona una empresa para probar el entorno del adaptador",
        failed_refresh_models: "No se pudieron actualizar los modelos del adaptador."
      },
      status: {
        live_opencode_local_only: "La detección en vivo de modelos OpenCode solo funciona para entornos locales. Se usa una lista curada y entrada manual para {{name}}."
      },
      cheap_model: {
        label: "Modelo económico",
        description: "Se usa cuando una ejecución solicita un perfil económico (p. ej., resúmenes de rutinas). El modelo principal no cambia.",
        adapter_default_placeholder: "Predeterminado del adaptador · {{model}}",
        no_default_placeholder: "Sin predeterminado del adaptador — elige un modelo más barato",
        fallback_note: "No se ha seleccionado explícitamente un modelo económico — el runtime usa <code>{{model}}</code>.",
        no_default_warning: "No hay modelo económico seleccionado y el adaptador no tiene valor predeterminado. Las ejecuciones del canal económico continuarán con el modelo principal con nota de fallback."
      }
    }
  },
  pt: {
    config_form: {
      section_execution: "Execução",
      experimental_badge: "Experimental",
      primary_model: "Modelo principal",
      fields: {
        default_environment: "Ambiente padrão",
        default_environment_hint: "Destino de execução padrão no nível do agente. As configurações do projeto e da tarefa podem substituí-lo.",
        default_environment_company_local: "Padrão da empresa (local)",
        continue_after_max_turn: "Continuar após parar por limite de passos",
        continuation_attempts: "Tentativas de continuação",
        continuation_delay_sec: "Atraso de continuação (seg)",
        unit_sec: "seg"
      },
      options: {
        auto: "Auto",
        minimal: "Mínimo",
        low: "Baixo",
        medium: "Médio",
        high: "Alto",
        xhigh: "Muito alto",
        plan: "Plano",
        ask: "Perguntar",
        max: "Máximo"
      },
      actions: {
        test: "Testar",
        refresh_models: "Atualizar modelos",
        refreshing: "Atualizando..."
      },
      errors: {
        select_company_secrets: "Selecione uma empresa para criar segredos",
        select_company_images: "Selecione uma empresa para fazer upload de imagens",
        select_company_detect_model: "Selecione uma empresa para detectar o modelo",
        select_company_test_environment: "Selecione uma empresa para testar o ambiente do adaptador",
        failed_refresh_models: "Falha ao atualizar modelos do adaptador."
      },
      status: {
        live_opencode_local_only: "A detecção ao vivo de modelos OpenCode funciona apenas para ambientes locais. Uma lista curada e entrada manual são usadas para {{name}}."
      },
      cheap_model: {
        label: "Modelo econômico",
        description: "Usado quando uma execução solicita um perfil econômico (p. ex., resumos de rotinas). O modelo principal não muda.",
        adapter_default_placeholder: "Padrão do adaptador · {{model}}",
        no_default_placeholder: "Sem padrão do adaptador — escolha um modelo mais barato",
        fallback_note: "Nenhum modelo econômico foi selecionado explicitamente — o runtime usa <code>{{model}}</code>.",
        no_default_warning: "Nenhum modelo econômico selecionado e o adaptador não tem valor padrão. As execuções do canal econômico continuarão com o modelo principal com nota de fallback."
      }
    }
  },
  uk: {
    config_form: {
      section_execution: "Виконання",
      experimental_badge: "Експериментальний",
      primary_model: "Основна модель",
      fields: {
        default_environment: "Середовище за замовчуванням",
        default_environment_hint: "Ціль виконання за замовчуванням на рівні агента. Налаштування проєкту та задачі можуть це змінити.",
        default_environment_company_local: "За замовчуванням для компанії (локально)",
        continue_after_max_turn: "Продовжити після зупинки за лімітом кроків",
        continuation_attempts: "Спроби продовження",
        continuation_delay_sec: "Затримка продовження (сек)",
        unit_sec: "сек"
      },
      options: {
        auto: "Авто",
        minimal: "Мінімальний",
        low: "Низький",
        medium: "Середній",
        high: "Високий",
        xhigh: "Дуже високий",
        plan: "План",
        ask: "Запитати",
        max: "Максимум"
      },
      actions: {
        test: "Тест",
        refresh_models: "Оновити моделі",
        refreshing: "Оновлення..."
      },
      errors: {
        select_company_secrets: "Оберіть компанію для створення секретів",
        select_company_images: "Оберіть компанію для завантаження зображень",
        select_company_detect_model: "Оберіть компанію для визначення моделі",
        select_company_test_environment: "Оберіть компанію для тестування середовища адаптера",
        failed_refresh_models: "Не вдалося оновити моделі адаптера."
      },
      status: {
        live_opencode_local_only: "Живе визначення моделей OpenCode працює лише для локальних середовищ. Використовується курований список та ручне введення для {{name}}."
      },
      cheap_model: {
        label: "Бюджетна модель",
        description: "Використовується, коли запуск запитує бюджетний профіль (напр. зведення процедур). Основна модель не змінюється.",
        adapter_default_placeholder: "За замовчуванням для адаптера · {{model}}",
        no_default_placeholder: "Немає значення адаптера за замовчуванням — оберіть дешевшу модель",
        fallback_note: "Бюджетну модель не вибрано явно — runtime використовує <code>{{model}}</code>.",
        no_default_warning: "Бюджетну модель не вибрано, і адаптер не має значення за замовчуванням. Запуски бюджетного каналу продовжуватимуться на основній моделі з позначкою про fallback."
      }
    }
  },
  zh: {
    config_form: {
      section_execution: "执行",
      experimental_badge: "实验性",
      primary_model: "主模型",
      fields: {
        default_environment: "默认环境",
        default_environment_hint: "智能体级别的默认执行目标。项目和任务设置可以覆盖它。",
        default_environment_company_local: "公司默认（本地）",
        continue_after_max_turn: "超过步骤限制后继续",
        continuation_attempts: "继续尝试次数",
        continuation_delay_sec: "继续延迟（秒）",
        unit_sec: "秒"
      },
      options: {
        auto: "自动",
        minimal: "最小",
        low: "低",
        medium: "中",
        high: "高",
        xhigh: "极高",
        plan: "规划",
        ask: "询问",
        max: "最大"
      },
      actions: {
        test: "测试",
        refresh_models: "刷新模型",
        refreshing: "刷新中..."
      },
      errors: {
        select_company_secrets: "选择公司以创建密钥",
        select_company_images: "选择公司以上传图片",
        select_company_detect_model: "选择公司以检测模型",
        select_company_test_environment: "选择公司以测试适配器环境",
        failed_refresh_models: "刷新适配器模型失败。"
      },
      status: {
        live_opencode_local_only: "OpenCode 模型实时检测仅适用于本地环境。对于 {{name}} 使用精选列表和手动输入。"
      },
      cheap_model: {
        label: "经济模型",
        description: "当运行请求经济配置文件时使用（例如例程摘要）。主模型不会更改。",
        adapter_default_placeholder: "适配器默认 · {{model}}",
        no_default_placeholder: "无适配器默认值 — 请选择更便宜的模型",
        fallback_note: "未明确选择经济模型 — runtime 使用 <code>{{model}}</code>。",
        no_default_warning: "未选择经济模型且适配器没有默认值。经济通道运行将继续使用主模型并带有 fallback 注释。"
      }
    }
  }
};

for (const [locale, patch] of Object.entries(AGENTS_CONFIG_FORM_PATCHES)) {
  fill(locale, 'agents.json', patch);
}

console.log('agents.json patches done.');
