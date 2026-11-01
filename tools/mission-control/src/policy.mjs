export const PROTECTED_CATEGORIES = Object.freeze([
  "money",
  "production",
  "customer_data",
  "customer_messages",
  "accounts",
  "credentials",
  "legal_compliance",
  "public_posts",
  "external_services",
]);

// These are the only approval types Paperclip currently exposes. Keep this
// list explicit: an upstream type added later must render as Unknown until its
// owner-approval boundary is reviewed here.
export const PROTECTED_APPROVAL_TYPES = Object.freeze({
  hire_agent: Object.freeze({ categories: Object.freeze(["accounts"]) }),
  approve_ceo_strategy: Object.freeze({ categories: Object.freeze([]) }),
  budget_override_required: Object.freeze({ categories: Object.freeze(["money"]) }),
  request_board_approval: Object.freeze({ categories: Object.freeze([]) }),
});

const KNOWN_UNPROTECTED_CATEGORIES = new Set(["read_only"]);

function normalizedCategories(categories) {
  return Array.isArray(categories)
    ? categories.filter((category) => typeof category === "string" && category.length > 0)
    : [];
}

export function classifyAction({ type, categories = [] } = {}) {
  const inputCategories = normalizedCategories(categories);
  const protectedCategories = inputCategories.filter((category) => PROTECTED_CATEGORIES.includes(category));
  const unknownCategories = inputCategories.filter(
    (category) => !PROTECTED_CATEGORIES.includes(category) && !KNOWN_UNPROTECTED_CATEGORIES.has(category),
  );
  const normalizedType = typeof type === "string" && type.length > 0 ? type : null;
  const approvalPolicy = normalizedType && Object.hasOwn(PROTECTED_APPROVAL_TYPES, normalizedType)
    ? PROTECTED_APPROVAL_TYPES[normalizedType]
    : undefined;

  if (approvalPolicy || protectedCategories.length > 0) {
    return {
      protected: true,
      categories: [...new Set([...protectedCategories, ...(approvalPolicy?.categories ?? [])])],
    };
  }

  // Unknown upstream metadata must not silently become an unprotected action.
  if (unknownCategories.length > 0 || (normalizedType !== null && !approvalPolicy)) {
    return { protected: "Unknown", categories: [] };
  }

  if (inputCategories.length === 0 && normalizedType === null) {
    return { protected: "Unknown", categories: [] };
  }

  return { protected: false, categories: [] };
}
