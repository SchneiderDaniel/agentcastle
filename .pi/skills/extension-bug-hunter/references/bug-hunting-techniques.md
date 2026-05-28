# Bug Hunting Techniques — Code Patterns

Detailed pattern catalog for each technique. Use as reference during Phase 3.

---

## 1. Boundary Analysis

### Off-by-One
```typescript
// BAD: <= when index is 0-based
for (let i = 0; i <= arr.length; i++) { ... }
// GOOD: <
for (let i = 0; i < arr.length; i++) { ... }

// BAD: slice with wrong end
arr.slice(0, arr.length - 1)  // drops last element unexpectedly
```

### Empty/Null States
```typescript
// BAD: crashes on empty
const first = items[0].name

// BAD: missing null check after optional chain
const name = obj?.items?.[0]?.name
return name.toUpperCase()  // crashes if null

// BAD: spread on undefined
const merged = { ...defaults, ...overrides }
// overrides could be undefined — spread undefined is fine, but
// what if overrides is null? Spreading null throws.
```

### Pagination Limits
```typescript
// BAD: hardcoded limit with no overflow check
const page = results.slice(offset, offset + 100)
// what if offset > results.length?

// BAD: cursor pagination without null check
while (cursor) {
  cursor = page.nextCursor  // could be undefined/null
}
```

### Timeout Boundaries
```typescript
// BAD: race between timeout and completion
const result = await Promise.race([
  doWork(),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), 5000)
  ),
])
// If doWork() completes after timeout rejection, the result is
// orphaned. No cleanup happens.
```

---

## 2. Type Safety Analysis

### `any` Usage
```typescript
// BAD: any
function process(data: any) { ... }

// BAD: unsafe cast
const result = response as SomeType  // no runtime validation

// BETTER: type guard or schema validation
function isSomeType(val: unknown): val is SomeType {
  return typeof val === "object" && val !== null && "field" in val
}
```

### `details: {}` Pattern
```typescript
// BAD: plain object breaks type safety
return {
  content: [{ type: "text", text: "done" }],
  details: {},  // ← Pi anti-pattern
}

// GOOD: typed details
return {
  content: [{ type: "text", text: "done" }],
  details: { processed: 42, skipped: 0 },
}
```

### TypeBox vs Runtime Mismatch
```typescript
// BAD: Type.Optional but runtime assumes present
parameters: Type.Object({
  name: Type.Optional(Type.String()),
}),
execute(toolCallId, params, ...) {
  return params.name.toUpperCase()  // crashes if name undefined
}

// BAD: Type.Union without narrowing
parameters: Type.Object({
  value: Type.Union([Type.String(), Type.Number()]),
}),
execute(toolCallId, params, ...) {
  return params.value + 1  // crashes if string
}
```

---

## 3. Error Path Tracing

### Empty Catch
```typescript
try {
  await riskyOperation()
} catch {
  // empty — error swallowed silently
}

try {
  await riskyOperation()
} catch {
  /* ok */
}
```

### Error Propagation
```typescript
// BAD: return error as success
try {
  const result = await doSomething()
  return { content: [{ type: "text", text: result }] }
} catch (err) {
  return { content: [{ type: "text", text: "something went wrong" }] }
}
// No isError: true, no error details

// BAD: throw without context
throw new Error("Failed")
// throw new Error("Failed to parse config: " + detail)
```

### Unhandled Promise
```typescript
// BAD: fire-and-forget promise
pi.on("event", async (event, ctx) => {
  doAsyncWork()  // no await, no catch
})

// FIX:
pi.on("event", async (event, ctx) => {
  try {
    await doAsyncWork()
  } catch (err) {
    ctx.ui.notify(`Error: ${err}`, "error")
  }
})
```

---

## 4. Concurrency Analysis

### Shared Mutable State
```typescript
// BAD: module-level state without session rebuild
let counter = 0

pi.registerTool({
  name: "increment",
  execute() {
    counter++  // race condition if called concurrently
    return { content: [{ type: "text", text: String(counter) }] }
  },
})
```

### Missing await
```typescript
// BAD: forgot await — function returns Promise not value
function getItems() {
  return fetchItems()  // returns Promise, not array
}

// BAD: mixing sync/async in map
const results = items.map(async (item) => {
  return await process(item)
})
// Returns Promise[], not processed items
```

### Promise.all without Error Handling
```typescript
// BAD: one rejection fails all
const results = await Promise.all(promises)

// FIX: individual error handling
const results = await Promise.allSettled(promises)
const failures = results.filter(r => r.status === "rejected")
```

### Signal Not Propagated
```typescript
// BAD: ctx.signal ignored
execute(toolCallId, params, signal, onUpdate, ctx) {
  return pi.exec("git", ["status"])  // should pass signal
}

// FIX:
execute(toolCallId, params, signal, onUpdate, ctx) {
  return pi.exec("git", ["status"], { signal })
}
```

---

## 5. Input Validation

### Missing Validation
```typescript
// BAD: no param checking
execute(toolCallId, params, ...) {
  const path = params.path  // could be undefined
}

// BAD: string without pattern constraint
parameters: Type.Object({
  path: Type.String(),
})
// No minLength, no pattern, no protection against empty strings
```

### Path Traversal
```typescript
// BAD: user path not resolved
const fullPath = join(ctx.cwd, params.path)  // params.path could be "../../etc/passwd"

// GOOD: resolve and compare
const resolved = resolve(ctx.cwd, params.path)
if (!resolved.startsWith(ctx.cwd)) {
  throw new Error("Path traversal detected")
}
```

### Shell Injection
```typescript
// BAD: string interpolation in command
const result = execSync(`git log --oneline ${params.branch}`, { cwd })
// If params.branch contains ; rm -rf /, bad things happen

// GOOD: args array
const result = pi.exec("git", ["log", "--oneline", params.branch], { cwd })
```

---

## 6. State Mutation Analysis

### Module-Level State
```typescript
// BAD: global array, never rebuilt
let items: string[] = []
pi.registerTool({
  name: "add_item",
  execute(toolCallId, params) {
    items.push(params.item)
    return { content: [...], details: { items } }
  },
})

// FIX: rebuild from session on start
pi.on("session_start", async (_event, ctx) => {
  items = []
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult"
        && entry.message.toolName === "add_item") {
      items = entry.message.details?.items ?? []
    }
  }
})
```

### Event Side Effects
```typescript
pi.on("tool_call", async (event, ctx) => {
  // BAD: side effect in blocking handler
  await writeFile("/tmp/audit.log", event.toolName)  // slow I/O in hot path
})
```

---

## 7. Resource Lifecycle

### Temp Files Not Cleaned
```typescript
// BAD: temp file left behind
const tmpFile = join(tmpdir(), "pi-tmp-" + Date.now())
await writeFile(tmpFile, data)
// ... use file ...
// Never unlinkSync or cleanup in finally
```

### Missing Finally
```typescript
// BAD: resource leak on error
const fd = fs.openSync(file, "w")
try {
  fs.writeSync(fd, data)
} finally {
  fs.closeSync(fd)  // ← needed
}
```

### Event Listeners
```typescript
// BAD: listener registered but never cleaned up on session_shutdown
pi.on("session_start", () => {
  process.on("SIGUSR2", handler)
})
// No pi.on("session_shutdown") to remove listener
```

---

## 8. Security Analysis

### Command Injection Vectors
```typescript
// BAD: gh exec with user-controlled args
execSync(`gh issue comment ${issueNum} --repo ${repo} --body "${userBody}"`, { ... })

// BAD: shell flag in pi.exec
pi.exec("bash", ["-c", `echo ${userInput}`])
```

### Trust Boundary
```typescript
// BAD: LLM-generated content used as security check
const isTrusted = llmResponse.includes("authorized")
// Should use hardcoded codeowner list, not LLM judgment
```

### Key Exposure
```typescript
// BAD: API key in tool result content
return {
  content: [{ type: "text", text: `API key: ${apiKey}` }],
}
```

---

## 9. Logic Errors

### Wrong Operator
```typescript
// BAD: assignment instead of comparison
if (value = "error") { ... }

// BAD: wrong comparison
if (items.length !== 0) return  // inverted: returns if NOT empty

// BAD: == vs === (allow type coercion unexpectedly)
if (value == null) { ... }  // catches both null AND undefined
```

### Copy-Paste Error
```typescript
// BAD: processing same item twice
const firstResult = processItem(items[0])
const secondResult = processItem(items[0])  // should be items[1]
```

### Missing Return
```typescript
// BAD: method returns undefined instead of result
function getConfig() {
  const config = parseConfig(file)
  // forgot return
}

// BAD: early return missing
if (condition) return  // ok
processMore()  // unreachable if condition true? or intentional?
```

---

## 10. API Misuse

### Event Return Shape
```typescript
// BAD: wrong blocking return
pi.on("tool_call", async (event, ctx) => {
  return { blocked: true }  // should be { block: true }
})

// BAD: missing block property
pi.on("tool_call", async (event, ctx) => {
  if (dangerous) return { block: true, reason: "..." }
  // If not dangerous, return nothing (undefined) → passes through
  // That's correct!
})
```

### TypeBox Schema Shape
```typescript
// BAD: missing description
parameters: Type.Object({
  name: Type.String(),  // no description — LLM won't know what to pass
})

// BAD: Object with no additionalProperties: false
parameters: Type.Object({
  name: Type.String(),
  age: Type.Optional(Type.Number()),
})
// LLM might pass extra fields silently
```

### Tool Result Format
```typescript
// BAD: missing content array
execute() {
  return { details: { ... } }  // must have content array
}

// BAD: content wrong type
execute() {
  return { content: "plain string" }  // must be array of content blocks
}

// CORRECT:
execute() {
  return {
    content: [{ type: "text", text: "result" }],
    details: { ... },
  }
}
```

### File Mutation Without Queue
```typescript
// BAD: custom tool edits file without withFileMutationQueue
// This races with built-in edit/write in parallel tool mode

execute(toolCallId, params, signal, onUpdate, ctx) {
  const resolvedPath = resolve(ctx.cwd, params.path)
  const content = readFileSync(resolvedPath, "utf-8")
  const updated = content.replace(params.old, params.new)
  writeFileSync(resolvedPath, updated)
}

// GOOD: participate in file mutation queue
execute(toolCallId, params, signal, onUpdate, ctx) {
  const resolvedPath = resolve(ctx.cwd, params.path)
  return withFileMutationQueue(resolvedPath, () => {
    const content = readFileSync(resolvedPath, "utf-8")
    const updated = content.replace(params.old, params.new)
    writeFileSync(resolvedPath, updated)
    return { content: [{ type: "text", text: "done" }] }
  })
}
```
