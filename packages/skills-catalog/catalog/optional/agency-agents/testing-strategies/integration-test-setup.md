# Integration Test Setup — Reference

> This file is referenced by SKILL.md. Read it when setting up new test infrastructure.

## Integration Tests (MANDATORY for every endpoint)

```kotlin
@MicronautTest(environments = ["test"], transactional = false)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class EmployeeControllerTest : AbstractControllerTest() {

  private lateinit var employeeClient: EmployeeClient

  @BeforeAll
  override fun beforeAll() {
    val url = embeddedServer.url.toString()
    val jackson = ObjectMapper().configured()
    val retrofit = Retrofits
      .newBuilder(url = url.toHttpUrl(), jackson = jackson)
      .build()
    employeeClient = retrofit.create(EmployeeClient::class.java)
  }

  @AfterEach
  fun cleanup() {
    database.primary.truncateAllTables()
  }
}
```

## ALWAYS Use Retrofit Clients

```kotlin
// RIGHT -- Retrofit client from module-client
val response = employeeClient.getEmployee(
  authorization = bearerToken(adminUser),
  id = employee.id
)

// WRONG -- raw HttpRequest
val request = HttpRequest.GET<Any>("/api/v1/employee?id=$id")  // NEVER
```

Why Retrofit:
- Same client interface the app uses in production
- Type-safe request/response — no manual JSON parsing
- Tests break when the API contract changes (good)

## Connection Pool for Parallel Tests

If tests fail with "cannot acquire connection" or "connection pool exhausted", bump `maxPoolSize` to 20. Default pool (5 connections) can't handle parallel test execution.

```kotlin
primaryPoolConfig = ConnectionPoolConfig(
  maxPoolSize = 20,
  minimumIdle = 5
)
```

## Run Tests

```bash
# All tests
./gradlew test

# Specific test class
./gradlew test --tests "com.yourcompany.EmployeeControllerTest"

# Module tests only
./gradlew :app:module-repository:test
```
