"use strict";
/**
 * WasmEdge Compiler
 *
 * Integrates WasmEdge SDK for compiling JavaScript to WebAssembly.
 * Provides WASI-compliant module generation for agent execution.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WASMEDGE_OPTIONS = void 0;
exports.generateWasmEdgeWrapper = generateWasmEdgeWrapper;
exports.generateWasmEdgeConfig = generateWasmEdgeConfig;
exports.validateWasmEdgeModule = validateWasmEdgeModule;
exports.getWasmEdgeBuildCommand = getWasmEdgeBuildCommand;
exports.parseWasmEdgeErrors = parseWasmEdgeErrors;
exports.getSourceMapPath = getSourceMapPath;
exports.generateWasmEdgeManifest = generateWasmEdgeManifest;
var path = require("node:path");
/**
 * Default WasmEdge options
 */
exports.DEFAULT_WASMEDGE_OPTIONS = {
    debug: true,
    sourcemap: true,
    optimize: 2,
    wasi: true,
};
/**
 * Generate WasmEdge-compatible JavaScript wrapper
 *
 * Creates a JavaScript module that implements the standard agent interface
 * and can be compiled with WasmEdge.
 */
function generateWasmEdgeWrapper(agentCode, config) {
    var wrapper = "\n// AgentVault WasmEdge Module\n// Agent: ".concat(config.name, "\n// Type: ").concat(config.type, "\n// Generated: ").concat(new Date().toISOString(), "\n\n// Agent state management\nlet _state = {};\nlet _initialized = false;\n\n// Agent initialization\nexport function init(configStr) {\n  try {\n    const config = JSON.parse(configStr);\n    _state = {\n      name: config.name,\n      type: config.type,\n      version: config.version,\n      memories: [],\n      tasks: [],\n      createdAt: Date.now(),\n    };\n    _initialized = true;\n    return 0; // Success\n  } catch (error) {\n    console.error('Init failed:', error);\n    return 1; // Error\n  }\n}\n\n// Agent step function\nexport function step(input) {\n  if (!_initialized) {\n    console.error('Agent not initialized');\n    return JSON.stringify({ error: 'Agent not initialized' });\n  }\n\n  try {\n    // Execute agent code with state\n    const result = (function() {\n      ").concat(agentCode, "\n    }).call(_state);\n\n    // Update state with execution result\n    _state.lastExecuted = Date.now();\n    _state.lastResult = result;\n\n    return JSON.stringify({\n      success: true,\n      result: result,\n      state: _state,\n    });\n  } catch (error) {\n    console.error('Step failed:', error);\n    return JSON.stringify({\n      success: false,\n      error: error.message,\n      state: _state,\n    });\n  }\n}\n\n// Get agent state as bytes\nexport function get_state() {\n  const stateJson = JSON.stringify(_state);\n  const bytes = new TextEncoder().encode(stateJson);\n  return bytes;\n}\n\n// Get agent state size\nexport function get_state_size() {\n  const stateJson = JSON.stringify(_state);\n  return new TextEncoder().encode(stateJson).length;\n}\n\n// Add memory entry\nexport function add_memory(type, content) {\n  const memory = {\n    type: type,\n    content: content,\n    timestamp: Date.now(),\n    importance: 1,\n  };\n  if (_state.memories) {\n    _state.memories.push(memory);\n  }\n  return 0;\n}\n\n// Get all memories\nexport function get_memories() {\n  return JSON.stringify(_state.memories || []);\n}\n\n// Get memories by type\nexport function get_memories_by_type(memoryType) {\n  const memories = (_state.memories || []).filter(m => m.type === memoryType);\n  return JSON.stringify(memories);\n}\n\n// Clear memories\nexport function clear_memories() {\n  _state.memories = [];\n  return 0;\n}\n\n// Add task to queue\nexport function add_task(taskId, description) {\n  const task = {\n    id: taskId,\n    description: description,\n    status: 'pending',\n    result: null,\n    timestamp: Date.now(),\n  };\n  if (_state.tasks) {\n    _state.tasks.push(task);\n  }\n  return 0;\n}\n\n// Get all tasks\nexport function get_tasks() {\n  return JSON.stringify(_state.tasks || []);\n}\n\n// Get pending tasks\nexport function get_pending_tasks() {\n  const pending = (_state.tasks || []).filter(t => t.status === 'pending');\n  return JSON.stringify(pending);\n}\n\n// Update task status\nexport function update_task_status(taskId, status, result) {\n  const task = (_state.tasks || []).find(t => t.id === taskId);\n  if (task) {\n    task.status = status;\n    task.result = result;\n    return 0;\n  }\n  return 1; // Task not found\n}\n\n// Clear all tasks\nexport function clear_tasks() {\n  _state.tasks = [];\n  return 0;\n}\n\n// Export module info\nexport function get_info() {\n  return JSON.stringify({\n    name: '").concat(config.name, "',\n    type: '").concat(config.type, "',\n    version: '").concat(config.version || '1.0.0', "',\n    initialized: _initialized,\n    stateSize: get_state_size(),\n  });\n}\n");
    return wrapper;
}
/**
 * Generate WasmEdge build configuration
 *
 * Creates configuration for WasmEdge compiler.
 */
function generateWasmEdgeConfig(config, options) {
    var _a, _b, _c, _d;
    if (options === void 0) { options = exports.DEFAULT_WASMEDGE_OPTIONS; }
    var buildConfig = {
        module_name: config.name,
        module_type: 'wasi',
        output_type: 'wasm',
        optimization_level: (_a = options.optimize) !== null && _a !== void 0 ? _a : 2,
        debug: (_b = options.debug) !== null && _b !== void 0 ? _b : true,
        generate_source_map: (_c = options.sourcemap) !== null && _c !== void 0 ? _c : true,
        enable_wasi: (_d = options.wasi) !== null && _d !== void 0 ? _d : true,
        target: 'wasm32',
        features: ['bulk-memory', 'mutable-globals', 'sign-ext'],
        exports: [
            'init',
            'step',
            'get_state',
            'get_state_size',
            'add_memory',
            'get_memories',
            'get_memories_by_type',
            'clear_memories',
            'add_task',
            'get_tasks',
            'get_pending_tasks',
            'update_task_status',
            'clear_tasks',
            'get_info',
        ],
    };
    return JSON.stringify(buildConfig, null, 2);
}
/**
 * Validate WasmEdge module
 *
 * Checks that a compiled module is valid WasmEdge WASM.
 */
function validateWasmEdgeModule(wasmBuffer) {
    var errors = [];
    // Check minimum size
    if (wasmBuffer.length < 8) {
        errors.push('WASM file too small (minimum 8 bytes)');
    }
    // Check WASM magic bytes
    var magic = wasmBuffer.subarray(0, 4);
    var expectedMagic = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
    if (!magic.equals(expectedMagic)) {
        errors.push('Invalid WASM magic bytes');
    }
    // Check version
    var version = wasmBuffer.subarray(4, 8);
    var expectedVersion = Buffer.from([0x01, 0x00, 0x00, 0x00]);
    if (!version.equals(expectedVersion)) {
        errors.push('Invalid WASM version (must be 1)');
    }
    // Check for required exports
    // In a real implementation, this would parse the WASM binary
    // and check the export section for required functions
    // For now, we'll just check the file is not empty
    if (wasmBuffer.length < 100) {
        errors.push('WASM file appears to be empty or incomplete');
    }
    return {
        valid: errors.length === 0,
        errors: errors,
    };
}
/**
 * Generate WasmEdge build command
 *
 * Returns the command line to compile JavaScript to WasmEdge WASM.
 * This is a placeholder - actual WasmEdge SDK usage would be integrated.
 */
function getWasmEdgeBuildCommand(sourcePath, outputPath, options) {
    var _a;
    if (options === void 0) { options = exports.DEFAULT_WASMEDGE_OPTIONS; }
    var args = [
        sourcePath,
        '--output', outputPath,
        '--target', 'wasm32',
        '--opt', String((_a = options.optimize) !== null && _a !== void 0 ? _a : 2),
    ];
    if (options.debug) {
        args.push('--debug');
    }
    if (options.sourcemap) {
        args.push('--sourcemap');
    }
    if (options.wasi) {
        args.push('--wasi');
    }
    return "wasmedge-compile ".concat(args.join(' '));
}
/**
 * Extract compilation errors from WasmEdge output
 *
 * Parses error messages from WasmEdge compiler output.
 */
function parseWasmEdgeErrors(output) {
    var errors = [];
    var lines = output.split('\n');
    for (var _i = 0, lines_1 = lines; _i < lines_1.length; _i++) {
        var line = lines_1[_i];
        if (line.includes('error:')) {
            errors.push(line.trim());
        }
        else if (line.includes('Error:')) {
            errors.push(line.trim());
        }
        else if (line.includes('ERROR')) {
            errors.push(line.trim());
        }
    }
    return errors;
}
/**
 * Get source map path for compiled WASM
 *
 * Returns the expected source map file path.
 */
function getSourceMapPath(wasmPath) {
    var dir = path.dirname(wasmPath);
    var basename = path.basename(wasmPath, '.wasm');
    return path.join(dir, "".concat(basename, ".wasm.map"));
}
/**
 * Generate module manifest for WasmEdge
 *
 * Creates a manifest file with module metadata.
 */
function generateWasmEdgeManifest(config, wasmPath, _outputPath) {
    var manifest = {
        module_name: config.name,
        module_type: 'agent',
        version: config.version || '1.0.0',
        agent_type: config.type,
        wasm_path: path.basename(wasmPath),
        created_at: new Date().toISOString(),
        features: {
            wasi: true,
            bulk_memory: true,
            mutable_globals: true,
            multi_value: false,
        },
        exports: [
            'init',
            'step',
            'get_state',
            'get_state_size',
            'add_memory',
            'get_memories',
            'get_memories_by_type',
            'clear_memories',
            'add_task',
            'get_tasks',
            'get_pending_tasks',
            'update_task_status',
            'clear_tasks',
            'get_info',
        ],
    };
    return JSON.stringify(manifest, null, 2);
}
