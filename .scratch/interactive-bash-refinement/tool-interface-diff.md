# 原生 Pi → 当前插件：工具接口 diff

依据：Pi 1.4.0 与真实 AgentSession 最终注册定义。这里展示 Schema（包括 description 和 outputSchema）、Snippet、Guidelines 三部分；原生没有 write_stdin。`+` 为插件新增，`-` 为原生移除。执行语义及来源对应见相邻记录。

## bash

### Schema

```diff
--- native Pi 1.4.0
+++ plugin
 {
   "name": "bash",
-  "description": "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
+  "description": "Runs a shell command, returning output or a session ID for ongoing interaction. Use write_stdin to continue the session. Output is bounded to 2000 lines or 50 KiB. Cancelling this call before it returns stops the process.",
   "parameters": {
     "type": "object",
     "required": [
       "command"
     ],
     "properties": {
       "command": {
         "type": "string",
-        "description": "Shell command to execute"
+        "description": "Shell command to execute."
       },
-      "timeout": {
+      "yield_time_ms": {
         "type": "number",
-        "description": "Timeout in seconds (optional, no default timeout)"
+        "minimum": 0,
+        "description": "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms. Commands that finish sooner return immediately. This does not limit command runtime; commands have no execution timeout."
+      },
+      "tty": {
+        "type": "boolean",
+        "description": "True allocates a PTY for the command; false or omitted uses plain pipes."
       }
-    }
+    },
+    "additionalProperties": false
   },
   "outputSchema": {
     "type": "object",
     "required": [
       "output",
       "truncated",
-      "exit_code",
       "wall_time_seconds"
     ],
     "properties": {
       "output": {
-        "type": "string",
-        "description": "Combined stdout and stderr, possibly truncated"
+        "type": "string"
       },
       "truncated": {
-        "type": "boolean"
+        "type": "boolean",
+        "description": "Whether this call's new output was truncated."
       },
       "full_output_path": {
         "type": "string",
-        "description": "Full output, when truncated"
+        "description": "Full command log, present when this call's output is truncated."
       },
+      "wall_time_seconds": {
+        "type": "number",
+        "minimum": 0,
+        "description": "Elapsed time of this tool call, not the command's total lifetime."
+      },
       "exit_code": {
-        "type": "number"
+        "type": "integer"
       },
-      "wall_time_seconds": {
-        "type": "number"
+      "session_id": {
+        "type": "integer",
+        "minimum": 1,
+        "maximum": 2147483646
       }
-    }
+    },
+    "additionalProperties": false
   }
 }
```

### Snippet

```diff
 "Execute bash commands (ls, grep, find, etc.)"
```

### Guidelines

```diff
 [
-  "You can inspect PI_* environment variables for current model and session details."
+  "You can inspect PI_* environment variables for current model and session details.",
+  "Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.",
+  "Treat shell command text as code. JSON.stringify() is not shell escaping; use proper shell quoting."
 ]
```

## write_stdin

### Schema

```diff
--- native Pi 1.4.0
+++ plugin
+{
+  "name": "write_stdin",
+  "description": "Writes characters to an existing command session and returns only new output. Cancelling this call only stops waiting, not the process.",
+  "parameters": {
+    "type": "object",
+    "required": [
+      "session_id"
+    ],
+    "properties": {
+      "session_id": {
+        "type": "integer",
+        "minimum": 1,
+        "maximum": 2147483646,
+        "description": "Identifier of the command session returned by bash or write_stdin."
+      },
+      "chars": {
+        "type": "string",
+        "description": "Characters to write to stdin. Defaults to empty, which polls without writing. In PTY mode, can contain Ctrl+C (\\u0003). In pipe mode, Ctrl+C is ordinary input, not a signal."
+      },
+      "yield_time_ms": {
+        "type": "number",
+        "minimum": 0,
+        "description": "Wait before yielding output. Non-empty writes default to 250 ms; effective range is 250-30000 ms. Empty polls default to 5000 ms; effective range is 5000-300000 ms. Commands that finish sooner return immediately. This does not limit command runtime."
+      }
+    },
+    "additionalProperties": false
+  },
+  "outputSchema": {
+    "type": "object",
+    "required": [
+      "output",
+      "truncated",
+      "wall_time_seconds"
+    ],
+    "properties": {
+      "output": {
+        "type": "string"
+      },
+      "truncated": {
+        "type": "boolean",
+        "description": "Whether this call's new output was truncated."
+      },
+      "full_output_path": {
+        "type": "string",
+        "description": "Full command log, present when this call's output is truncated."
+      },
+      "wall_time_seconds": {
+        "type": "number",
+        "minimum": 0,
+        "description": "Elapsed time of this tool call, not the command's total lifetime."
+      },
+      "exit_code": {
+        "type": "integer"
+      },
+      "session_id": {
+        "type": "integer",
+        "minimum": 1,
+        "maximum": 2147483646
+      }
+    },
+    "additionalProperties": false
+  }
+}
```

### Snippet

```diff
+"Send input to a command session or wait for new output"
```

### Guidelines

```diff
+[
+  "When bash or write_stdin returns a session_id, use write_stdin with that ID to continue the same process. Do not restart the command just because a wait window expired.",
+  "There is no completion notification or automatic wake-up. If the user's task requires the result, keep using write_stdin until completion."
+]
```

## 模型实际可见性

直接模式的工具简介和规则已在最终 system message 中验证。codemode-only 模式下，Pi 隐藏直接工具声明，并把 Guidelines 合入 codemode 的工具说明；对应真实请求检查通过。完整请求产物路径见验证记录，不将注册字段存在等同于已经进入模型上下文。
