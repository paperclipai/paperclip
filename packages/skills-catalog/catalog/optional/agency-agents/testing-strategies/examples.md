# Testing Examples — Reference Code

> This file is referenced by SKILL.md. Read it when you need code examples for writing tests.

## Test Data Builders

Use `dummyEntity()` helpers with sensible defaults so tests only specify what matters.

```kotlin
private fun dummyEntity(
  id: UUID = UUID.randomUUID(),
  name: String = randomText(),
  email: String = randomEmail(),
  status: String = EmployeeStatus.ACTIVE.value
) = EmployeeEntity(
  id = id,
  name = name,
  email = email,
  status = status,
  createdAt = Instant.now(),
  updatedAt = null,
  deletedAt = null
)
```

## Assertions

```kotlin
// Use AssertJ
assertThat(result).isNotNull
assertThat(result.id).isEqualTo(expected.id)
assertThat(list).hasSize(3)
assertThat(entity.deletedAt).isNull()

// Compare ignoring timestamps
assertThat(result)
  .usingRecursiveComparison()
  .ignoringFields("createdAt", "updatedAt")
  .isEqualTo(expected)
```

## Unit Tests with MockK

Use MockK for testing managers and services in isolation.

```kotlin
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest

class ChatServiceTest {
  private val mockClient = mockk<ChatClient>()
  private val service = ChatService(mockClient)

  @Test
  fun `should handle basic chat request`() = runTest {
    // Given
    coEvery { mockClient.chat(any()) } returns mockResponse

    // When
    val response = service.chat(messages)

    // Then
    assertNotNull(response)
    coVerify(exactly = 1) { mockClient.chat(any()) }
  }

  @Test
  fun `should send correct model in request`() = runTest {
    // Given — capture the argument to verify WHAT was sent
    val captured = slot<ChatRequest>()
    coEvery { mockClient.chat(capture(captured)) } returns mockResponse

    // When
    service.chat(messages)

    // Then
    assertEquals("gpt-4", captured.captured.model)
  }
}
```

### Organize with @Nested

```kotlin
@Nested
@DisplayName("Chat Operations")
inner class ChatOperations {
  @BeforeEach
  fun setup() {
    coEvery { mockClient.chat(any()) } returns mockResponse
  }

  @Test
  fun `should return zero credits when quota throws`() = runTest {
    coEvery { quotaService.getRemaining(any()) } throws RuntimeException("boom")
    val result = service.getCredits(userId)
    assertThat(result.creditsRemaining).isEqualTo(0)
  }
}
```
