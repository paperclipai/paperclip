/**
 * Candid IDL Factory for AgentVault canister
 *
 * This file provides the IDL factory function used to create canister actors.
 * It's manually generated based on agent.did to avoid build-time dependencies.
 */

export const idlFactory = ({ IDL }: any) => IDL.Service({
  // ==================== Agent Lifecycle ====================
  getAgentConfig: IDL.Func([], [IDL.Opt(IDL.Record({
    name: IDL.Text,
    agentType: IDL.Text,
    version: IDL.Text,
    createdAt: IDL.Int,
  }))], ['query']),

  getAgentStatus: IDL.Func([], [IDL.Record({
    initialized: IDL.Bool,
    version: IDL.Text,
    totalMemories: IDL.Nat,
    totalTasks: IDL.Nat,
    wasmLoaded: IDL.Bool,
    executionCount: IDL.Nat,
    lastExecuted: IDL.Int,
  })], ['query']),

  setAgentConfig: IDL.Func([IDL.Record({
    name: IDL.Text,
    agentType: IDL.Text,
    version: IDL.Text,
    createdAt: IDL.Int,
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  // ==================== WASM Module Management ====================
  loadAgentWasm: IDL.Func([IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  getWasmInfo: IDL.Func([], [IDL.Opt(IDL.Record({
    hash: IDL.Vec(IDL.Nat8),
    size: IDL.Nat,
    loadedAt: IDL.Int,
    functionNameCount: IDL.Nat,
  }))], ['query']),

  isWasmLoaded: IDL.Func([], [IDL.Bool], ['query']),

  // ==================== Agent Interface ====================
  agent_init: IDL.Func([IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),

  agent_step: IDL.Func([IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),

  agent_get_state: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),

  agent_get_state_size: IDL.Func([], [IDL.Nat], ['query']),

  agent_add_memory: IDL.Func([IDL.Nat, IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),

  agent_get_memories: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),

  agent_get_memories_by_type: IDL.Func([IDL.Nat], [IDL.Vec(IDL.Nat8)], ['query']),

  agent_clear_memories: IDL.Func([], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),

  agent_add_task: IDL.Func([IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),

  agent_get_tasks: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),

  agent_get_pending_tasks: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),

  agent_update_task_status: IDL.Func([IDL.Vec(IDL.Nat8), IDL.Nat, IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),

  agent_clear_tasks: IDL.Func([], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),

  agent_get_info: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),

  // ==================== Legacy Functions ====================
  execute: IDL.Func([IDL.Text], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  addMemory: IDL.Func([IDL.Record({
    id: IDL.Text,
    memoryType: IDL.Variant({
      fact: IDL.Null,
      user_preference: IDL.Null,
      task_result: IDL.Null,
    }),
    content: IDL.Text,
    timestamp: IDL.Int,
    importance: IDL.Nat8,
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  getMemories: IDL.Func([], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    memoryType: IDL.Variant({
      fact: IDL.Null,
      user_preference: IDL.Null,
      task_result: IDL.Null,
    }),
    content: IDL.Text,
    timestamp: IDL.Int,
    importance: IDL.Nat8,
  }))], ['query']),

  getMemoriesByType: IDL.Func([IDL.Variant({
    fact: IDL.Null,
    user_preference: IDL.Null,
    task_result: IDL.Null,
  })], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    memoryType: IDL.Variant({
      fact: IDL.Null,
      user_preference: IDL.Null,
      task_result: IDL.Null,
    }),
    content: IDL.Text,
    timestamp: IDL.Int,
    importance: IDL.Nat8,
  }))], ['query']),

  clearMemories: IDL.Func([], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  addTask: IDL.Func([IDL.Record({
    id: IDL.Text,
    description: IDL.Text,
    status: IDL.Variant({
      pending: IDL.Null,
      running: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    timestamp: IDL.Int,
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  getTasks: IDL.Func([], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    description: IDL.Text,
    status: IDL.Variant({
      pending: IDL.Null,
      running: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    timestamp: IDL.Int,
  }))], ['query']),

  getPendingTasks: IDL.Func([], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    description: IDL.Text,
    status: IDL.Variant({
      pending: IDL.Null,
      running: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    timestamp: IDL.Int,
  }))], ['query']),

  getRunningTasks: IDL.Func([], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    description: IDL.Text,
    status: IDL.Variant({
      pending: IDL.Null,
      running: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    timestamp: IDL.Int,
  }))], ['query']),

  updateTaskStatus: IDL.Func([IDL.Text, IDL.Variant({
    pending: IDL.Null,
    running: IDL.Null,
    completed: IDL.Null,
    failed: IDL.Null,
  }), IDL.Opt(IDL.Text)], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  clearTasks: IDL.Func([], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  // ==================== Context Management ====================
  setContext: IDL.Func([IDL.Tuple(IDL.Text, IDL.Text)], [IDL.Text], []),

  getContext: IDL.Func([IDL.Text], [IDL.Opt(IDL.Text)], ['query']),

  getAllContext: IDL.Func([], [IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text))], ['query']),

  clearContext: IDL.Func([], [IDL.Text], []),

  // ==================== Wallet Registry (Phase 5A) ====================
  registerWallet: IDL.Func([IDL.Record({
    id: IDL.Text,
    agentId: IDL.Text,
    chain: IDL.Text,
    address: IDL.Text,
    registeredAt: IDL.Int,
    status: IDL.Variant({
      active: IDL.Null,
      inactive: IDL.Null,
      revoked: IDL.Null,
    }),
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  getWallet: IDL.Func([IDL.Text], [IDL.Opt(IDL.Record({
    id: IDL.Text,
    agentId: IDL.Text,
    chain: IDL.Text,
    address: IDL.Text,
    registeredAt: IDL.Int,
    status: IDL.Variant({
      active: IDL.Null,
      inactive: IDL.Null,
      revoked: IDL.Null,
    }),
  }))], ['query']),

  listWallets: IDL.Func([IDL.Text], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    agentId: IDL.Text,
    chain: IDL.Text,
    address: IDL.Text,
    registeredAt: IDL.Int,
    status: IDL.Variant({
      active: IDL.Null,
      inactive: IDL.Null,
      revoked: IDL.Null,
    }),
  }))], ['query']),

  deregisterWallet: IDL.Func([IDL.Text], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  updateWalletStatus: IDL.Func([IDL.Text, IDL.Variant({
    active: IDL.Null,
    inactive: IDL.Null,
    revoked: IDL.Null,
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  // ==================== Transaction Queue (Phase 5B) ====================
  queueTransaction: IDL.Func([IDL.Record({
    walletId: IDL.Text,
    action: IDL.Variant({
      send_funds: IDL.Null,
      sign_message: IDL.Null,
      deploy_contract: IDL.Null,
    }),
    parameters: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    priority: IDL.Variant({
      low: IDL.Null,
      normal: IDL.Null,
      high: IDL.Null,
    }),
    threshold: IDL.Opt(IDL.Nat),
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  getQueuedTransactions: IDL.Func([], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    walletId: IDL.Text,
    action: IDL.Variant({
      send_funds: IDL.Null,
      sign_message: IDL.Null,
      deploy_contract: IDL.Null,
    }),
    parameters: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    priority: IDL.Variant({
      low: IDL.Null,
      normal: IDL.Null,
      high: IDL.Null,
    }),
    threshold: IDL.Opt(IDL.Nat),
    status: IDL.Variant({
      pending: IDL.Null,
      queued: IDL.Null,
      signed: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    retryCount: IDL.Nat,
    scheduledAt: IDL.Opt(IDL.Int),
    createdAt: IDL.Int,
    signedAt: IDL.Opt(IDL.Int),
    completedAt: IDL.Opt(IDL.Int),
    errorMessage: IDL.Opt(IDL.Text),
  }))], ['query']),

  getPendingTransactions: IDL.Func([], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    walletId: IDL.Text,
    action: IDL.Variant({
      send_funds: IDL.Null,
      sign_message: IDL.Null,
      deploy_contract: IDL.Null,
    }),
    parameters: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    priority: IDL.Variant({
      low: IDL.Null,
      normal: IDL.Null,
      high: IDL.Null,
    }),
    threshold: IDL.Opt(IDL.Nat),
    status: IDL.Variant({
      pending: IDL.Null,
      queued: IDL.Null,
      signed: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    retryCount: IDL.Nat,
    scheduledAt: IDL.Opt(IDL.Int),
    createdAt: IDL.Int,
    signedAt: IDL.Opt(IDL.Int),
    completedAt: IDL.Opt(IDL.Int),
    errorMessage: IDL.Opt(IDL.Text),
  }))], ['query']),

  getQueuedTransactionsByWallet: IDL.Func([IDL.Text], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    walletId: IDL.Text,
    action: IDL.Variant({
      send_funds: IDL.Null,
      sign_message: IDL.Null,
      deploy_contract: IDL.Null,
    }),
    parameters: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    priority: IDL.Variant({
      low: IDL.Null,
      normal: IDL.Null,
      high: IDL.Null,
    }),
    threshold: IDL.Opt(IDL.Nat),
    status: IDL.Variant({
      pending: IDL.Null,
      queued: IDL.Null,
      signed: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    retryCount: IDL.Nat,
    scheduledAt: IDL.Opt(IDL.Int),
    createdAt: IDL.Int,
    signedAt: IDL.Opt(IDL.Int),
    completedAt: IDL.Opt(IDL.Int),
    errorMessage: IDL.Opt(IDL.Text),
  }))], ['query']),

  getQueuedTransaction: IDL.Func([IDL.Text], [IDL.Opt(IDL.Record({
    id: IDL.Text,
    walletId: IDL.Text,
    action: IDL.Variant({
      send_funds: IDL.Null,
      sign_message: IDL.Null,
      deploy_contract: IDL.Null,
    }),
    parameters: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    priority: IDL.Variant({
      low: IDL.Null,
      normal: IDL.Null,
      high: IDL.Null,
    }),
    threshold: IDL.Opt(IDL.Nat),
    status: IDL.Variant({
      pending: IDL.Null,
      queued: IDL.Null,
      signed: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    retryCount: IDL.Nat,
    scheduledAt: IDL.Opt(IDL.Int),
    createdAt: IDL.Int,
    signedAt: IDL.Opt(IDL.Int),
    completedAt: IDL.Opt(IDL.Int),
    errorMessage: IDL.Opt(IDL.Text),
  }))], ['query']),

  markTransactionSigned: IDL.Func([IDL.Text, IDL.Text], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  markTransactionCompleted: IDL.Func([IDL.Text, IDL.Text], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  markTransactionFailed: IDL.Func([IDL.Text, IDL.Text], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  retryTransaction: IDL.Func([IDL.Text], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  scheduleTransaction: IDL.Func([IDL.Text, IDL.Int], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  clearCompletedTransactions: IDL.Func([], [IDL.Text], []),

  getTransactionQueueStats: IDL.Func([], [IDL.Record({
    total: IDL.Nat,
    pending: IDL.Nat,
    queued: IDL.Nat,
    signed: IDL.Nat,
    completed: IDL.Nat,
    failed: IDL.Nat,
  })], ['query']),

  // ==================== VetKeys Functions (Phase 5D) ====================
  storeEncryptedSecret: IDL.Func([IDL.Record({
    id: IDL.Text,
    ciphertext: IDL.Vec(IDL.Nat8),
    iv: IDL.Vec(IDL.Nat8),
    tag: IDL.Vec(IDL.Nat8),
    algorithm: IDL.Variant({
      aes_256_gcm: IDL.Null,
      chacha20_poly1305: IDL.Null,
    }),
    createdAt: IDL.Int,
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  getEncryptedSecret: IDL.Func([IDL.Text], [IDL.Opt(IDL.Record({
    id: IDL.Text,
    ciphertext: IDL.Vec(IDL.Nat8),
    iv: IDL.Vec(IDL.Nat8),
    tag: IDL.Vec(IDL.Nat8),
    algorithm: IDL.Variant({
      aes_256_gcm: IDL.Null,
      chacha20_poly1305: IDL.Null,
    }),
    createdAt: IDL.Int,
  }))], ['query']),

  listEncryptedSecrets: IDL.Func([], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    ciphertext: IDL.Vec(IDL.Nat8),
    iv: IDL.Vec(IDL.Nat8),
    tag: IDL.Vec(IDL.Nat8),
    algorithm: IDL.Variant({
      aes_256_gcm: IDL.Null,
      chacha20_poly1305: IDL.Null,
    }),
    createdAt: IDL.Int,
  }))], ['query']),

  deleteEncryptedSecret: IDL.Func([IDL.Text], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  verifyThresholdSignature: IDL.Func([IDL.Text, IDL.Text], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], ['query']),

  deriveVetKeysKey: IDL.Func([IDL.Text, IDL.Nat], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  getVetKeysStatus: IDL.Func([], [IDL.Record({
    enabled: IDL.Bool,
    thresholdSupported: IDL.Bool,
    mode: IDL.Variant({
      mock: IDL.Null,
      production: IDL.Null,
    }),
  })], ['query']),

  // ==================== System Functions ====================
  getCanisterStatus: IDL.Func([], [IDL.Record({
    status: IDL.Variant({
      running: IDL.Null,
      stopping: IDL.Null,
      stopped: IDL.Null,
    }),
    memorySize: IDL.Nat,
    cycles: IDL.Nat,
  })], ['query']),

  getMetrics: IDL.Func([], [IDL.Record({
    uptime: IDL.Int,
    operations: IDL.Nat,
    lastActivity: IDL.Int,
  })], ['query']),

  heartbeat: IDL.Func([], [IDL.Bool], []),

  // ==================== MCP Server Registration ====================
  registerMCPServer: IDL.Func([IDL.Record({
    namespace: IDL.Text,
    entryPoint: IDL.Text,
    healthPort: IDL.Opt(IDL.Nat),
    tools: IDL.Vec(IDL.Text),
    metadata: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),

  listMCPServers: IDL.Func([], [IDL.Vec(IDL.Record({
    namespace: IDL.Text,
    entryPoint: IDL.Text,
    healthPort: IDL.Opt(IDL.Nat),
    tools: IDL.Vec(IDL.Text),
    metadata: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    registeredAt: IDL.Int,
    lastHealthCheck: IDL.Opt(IDL.Int),
    healthy: IDL.Bool,
  }))], ['query']),

  removeMCPServer: IDL.Func([IDL.Text], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),
});
