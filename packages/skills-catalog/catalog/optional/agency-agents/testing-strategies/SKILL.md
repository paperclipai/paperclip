---
name: "testing-strategies"
description: "Testing patterns for Micronaut/Kotlin backend including repository tests, integration tests, and test data builders. Use when writing tests, setting up test infrastructure, or improving coverage."
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
key: "paperclipai/optional/agency-agents/testing-strategies"
recommendedForRoles:
  - "engineer"
  - "designer"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "testing"
  - "strategies"
defaultInstall: false
---
# Testing Strategies — Quick Reference

> See `integration-test-setup.md` for @MicronautTest configuration, Retrofit client setup, and connection pool tuning.
>
> See `examples.md` for complete code patterns including MockK, test data builders, and assertions.

## Integration Tests

Every endpoint needs an integration test. Extend `AbstractControllerTest`, use Retrofit clients from `module-client`, and clean up with `truncateAllTables()` in `@AfterEach`.

Key rules:
- **Always use Retrofit clients** — never raw `HttpRequest`
- Generate real JWT tokens via `accessToken()`
- Test full HTTP stack end-to-end, no mocking managers

## Test Naming

```kotlin
@Test
fun `{action} - {expected outcome}`() = runBlocking { }

// Examples:
fun `getEmployee - returns employee by id`() = runBlocking { }
fun `getEmployee - returns 404 when not found`() = runBlocking { }
fun `createEmployee - fails with 401 when not authenticated`() = runBlocking { }
```

## Required Test Coverage Per Endpoint

1. **Happy path** — basic success case
2. **Not found** — 404 for missing resource
3. **Auth failure** — 401 without token
4. **Soft delete** — deleted records not returned

```kotlin
@Test
fun `getById - returns 404 when not found`() = runBlocking {
  val token = accessToken(prepareUser())
  assertThrows<HttpException> {
    runBlocking {
      client.getById(authorization = token, id = UUID.randomUUID())
    }
  }.also {
    assertThat(it.code()).isEqualTo(404)
  }
}
```

## Repository Tests

Extend `AbstractRepositoryTest`. Every repository needs these tests at minimum:

```kotlin
class DefaultEmployeeRepositoryTest : AbstractRepositoryTest() {

  private val repository = DefaultEmployeeRepository(database)

  @BeforeEach
  fun cleanup() { database.primary.truncateAllTables() }

  @Test
  fun `insert - happy path`() { }

  @Test
  fun `byId - returns entity when exists`() { }

  @Test
  fun `byId - returns null when not exists`() { }

  @Test
  fun `byId - returns null when soft deleted`() { }

  @Test
  fun `deleteById - soft deletes entity`() { }

  @Test
  fun `update - updates selected fields`() { }
}
```

## MockK Rules

- `mockk<T>()` for creating mocks
- `coEvery` / `coVerify` for suspend functions (not `every`/`verify`)
- `slot<T>()` + `capture()` to verify what arguments were passed
- `runTest { }` from `kotlinx.coroutines.test` — NOT `runBlocking`. `runTest` handles virtual time and catches coroutine issues.
- AAA pattern with comments: `// Given`, `// When`, `// Then`
- Use `@Nested` + `@DisplayName` to group related tests

> See `examples.md` for full MockK code examples, `@Nested` patterns, test data builders, and AssertJ assertions.

## Gotchas

**Connection pool exhaustion:** If parallel tests fail with "cannot acquire connection", bump `maxPoolSize` to 20. See `integration-test-setup.md` for the config snippet.

**MockK + coroutines:** Always use `coEvery`/`coVerify` for suspend functions. Plain `every`/`verify` won't work and gives confusing errors.

## Run Tests

```bash
./gradlew test                                                    # All tests
./gradlew test --tests "com.yourcompany.EmployeeControllerTest"   # One class
./gradlew :app:module-repository:test                             # One module
```
