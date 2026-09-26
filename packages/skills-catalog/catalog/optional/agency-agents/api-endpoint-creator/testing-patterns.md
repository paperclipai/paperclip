# API Endpoint Testing Patterns

How to write integration tests for API endpoints in the platform.

---

## Test Structure

```
Integration Test (Controller)
    -> Retrofit HTTP Client
    -> Actual HTTP Request
    -> Controller -> Manager -> Repository -> Database
    -> HTTP Response
    -> Assertions
```

Integration tests check the full stack works together.

---

## Base Test Class

All controller tests extend `AbstractControllerTest`:

```kotlin
@MicronautTest(environments = ["test"], transactional = false)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ProjectControllerTest : AbstractControllerTest() {

  private lateinit var projectClient: ProjectClient

  @BeforeAll
  override fun beforeAll() {
    val url = embeddedServer.url.toString()
    val jackson = ObjectMapper().configured()
    val retrofit = Retrofits
      .newBuilder(url = url.toHttpUrl(), jackson = jackson)
      .build()

    projectClient = retrofit.create(ProjectClient::class.java)
  }

  @AfterEach
  fun cleanupAfterEach() {
    database.primary.truncateAllTables()
  }
}
```

**Key Points**:
- `@MicronautTest(environments = ["test"])` - Use test environment
- `@TestInstance(Lifecycle.PER_CLASS)` - Reuse test instance
- Extend `AbstractControllerTest` for utilities
- Create Retrofit client in `@BeforeAll`
- Clean database in `@AfterEach`

---

## Retrofit Client

**File**: `app/module-client/src/main/kotlin/com/yourcompany/client/ProjectClient.kt`

```kotlin
package com.yourcompany.client

import com.yourcompany.client.request.{domain}.CreateProjectRequest
import com.yourcompany.client.response.{domain}.ProjectResponse
import com.yourcompany.client.response.{domain}.ProjectListResponse
import retrofit2.http.*
import java.util.UUID

interface ProjectClient {

  @GET("/api/v1/admin/projects")
  suspend fun listProjects(
    @Header("Authorization") authorization: String,
    @Query("page") page: Int? = null,
    @Query("limit") limit: Int? = null
  ): ProjectListResponse

  @GET("/api/v1/admin/project")
  suspend fun getProject(
    @Header("Authorization") authorization: String,
    @Query("id") id: UUID
  ): ProjectResponse

  @POST("/api/v1/admin/project")
  suspend fun createProject(
    @Header("Authorization") authorization: String,
    @Body request: CreateProjectRequest
  ): ProjectResponse

  @POST("/api/v1/admin/project/delete")
  suspend fun deleteProject(
    @Header("Authorization") authorization: String,
    @Query("id") id: UUID
  ): Boolean
}
```

---

## Test Pattern 1: Happy Path

```kotlin
@Test
fun `getProject - returns project when exists`() = runBlocking {
  val project = createTestProject()
  val token = accessToken(prepareUser(), UserRole.ADMIN)

  val response = projectClient.getProject(
    authorization = token,
    id = project.id
  )

  assertThat(response.id).isEqualTo(project.id)
  assertThat(response.name).isEqualTo(project.name)
}
```

## Test Pattern 2: Not Found (404)

```kotlin
@Test
fun `getProject - returns 404 when not found`() = runBlocking {
  val token = accessToken(prepareUser(), UserRole.ADMIN)

  val exception = assertThrows<HttpException> {
    runBlocking {
      projectClient.getProject(
        authorization = token,
        id = UUID.randomUUID()
      )
    }
  }

  assertThat(exception.code()).isEqualTo(404)
}
```

## Test Pattern 3: Authentication (401)

```kotlin
@Test
fun `should return 401 when not authenticated`() = runBlocking {
  val exception = assertThrows<HttpException> {
    runBlocking {
      projectClient.getProject(
        authorization = "",
        id = UUID.randomUUID()
      )
    }
  }

  assertThat(exception.code()).isEqualTo(401)
}
```

## Test Pattern 4: Create and Verify

```kotlin
@Test
fun `createProject - creates project successfully`() = runBlocking {
  val token = accessToken(prepareUser(), UserRole.ADMIN)
  val request = CreateProjectRequest(
    name = "Test Project",
    description = "A test project"
  )

  val response = projectClient.createProject(
    authorization = token,
    request = request
  )

  assertThat(response.name).isEqualTo("Test Project")
  assertThat(response.description).isEqualTo("A test project")

  // Verify in database
  val saved = projectRepository.byId(response.id)
  assertThat(saved).isNotNull
  assertThat(saved?.name).isEqualTo("Test Project")
}
```

## Test Pattern 5: List with Pagination

```kotlin
@Test
fun `listProjects - returns paginated results`() = runBlocking {
  createTestProject(name = "Project A")
  createTestProject(name = "Project B")
  createTestProject(name = "Project C")

  val token = accessToken(prepareUser(), UserRole.ADMIN)

  val response = projectClient.listProjects(
    authorization = token,
    page = 1,
    limit = 2
  )

  assertThat(response.items).hasSize(2)
  assertThat(response.total).isEqualTo(3)
  assertThat(response.hasMore).isTrue()
}
```

## Test Pattern 6: Soft Delete

```kotlin
@Test
fun `deleteProject - soft deletes project`() = runBlocking {
  val project = createTestProject()
  val token = accessToken(prepareUser(), UserRole.ADMIN)

  val result = projectClient.deleteProject(
    authorization = token,
    id = project.id
  )

  assertThat(result).isTrue()

  // Verify not returned by queries
  val exception = assertThrows<HttpException> {
    runBlocking {
      projectClient.getProject(authorization = token, id = project.id)
    }
  }
  assertThat(exception.code()).isEqualTo(404)
}
```

---

## Test Helper Patterns

```kotlin
private val projectRepository: ProjectRepository by lazy {
  DefaultProjectRepository(database)
}

private fun createTestProject(
  name: String = "Test Project ${UUID.randomUUID()}",
  description: String? = "Test description",
  status: String = "active"
): ProjectEntity {
  return projectRepository.insert(
    ProjectEntity(
      name = name,
      description = description,
      status = status
    )
  )
}
```

**Utility methods from `AbstractControllerTest`**:
- `prepareUser(email, displayName, role)` - Create test user
- `accessToken(user, role)` - Generate JWT token
- `database` - DatabaseContext for direct DB access

---

## Test Scenarios Checklist

For each endpoint, test:

### Create
- [ ] Happy path succeeds
- [ ] Returns created resource
- [ ] Resource exists in database
- [ ] Requires authentication (401)

### Read (Get by ID)
- [ ] Returns resource when exists (200)
- [ ] Returns 404 when not found
- [ ] Requires authentication (401)

### List
- [ ] Returns paginated results
- [ ] Pagination works (page/limit)
- [ ] Returns empty list when no results
- [ ] Requires authentication (401)

### Delete
- [ ] Soft deletes successfully
- [ ] Resource not returned after deletion
- [ ] Returns 404 when not found
- [ ] Requires authentication (401)

---

## Best Practices

1. **Isolation**: Clean database between tests (`@AfterEach`)
2. **Random data**: Use UUIDs in names to avoid conflicts
3. **AssertJ**: Use `assertThat` for readable assertions
4. **Given/When/Then**: Structure tests clearly
5. **Verify database**: Don't just check the response
6. **Auth tests**: Always test with and without auth
7. **Use Retrofit clients**: Never raw HttpRequest for API tests
