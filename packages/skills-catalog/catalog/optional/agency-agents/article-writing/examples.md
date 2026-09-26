# Article Writing — Good vs Bad Examples

> Read these examples to calibrate your writing style. The "bad" versions are typical AI output. The "good" versions sound like a person wrote them.

## Intro Paragraphs

### Bad (AI-style)
> In today's rapidly evolving technological landscape, the importance of effective error handling cannot be overstated. This comprehensive guide will walk you through the various aspects of implementing robust error handling strategies in your Kotlin applications, enabling you to build more resilient and maintainable software systems.

### Good (human-style)
> Last Tuesday, our payment service threw 4,000 unhandled exceptions in 20 minutes. The fix was 3 lines of code. Here's what went wrong and how to make sure it doesn't happen to you.

---

## Explaining a Concept

### Bad (AI-style)
> Dependency injection is a crucial software design pattern that facilitates the development of loosely coupled, maintainable, and testable code. By leveraging this paradigm, developers can effectively manage the complex dependencies between various components of their application architecture.

### Good (human-style)
> Dependency injection means your class doesn't create its own dependencies — someone hands them in. Instead of `val db = Database()` inside your class, you write `class UserRepo(val db: Database)` and let the framework wire it up. That's it. The rest is details.

---

## Technical Guide Section

### Bad (AI-style)
> To implement this feature, you'll want to start by carefully considering the architectural implications. First, create a new service class that will handle the business logic. Then, implement the necessary repository methods. Finally, wire everything together in the controller layer. This approach ensures a clean separation of concerns.

### Good (human-style)
> Three files to create:
> 1. `PaymentManager.kt` — validates the amount, calls Stripe, saves the record
> 2. `PaymentRepository.kt` — insert and soft-delete methods
> 3. `PaymentController.kt` — one POST endpoint, delegates to the manager
>
> Start with the manager. The other two are boilerplate.

---

## Transitions Between Sections

### Bad (AI-style)
> Now that we've explored the fundamentals of error handling, let's delve into the more advanced aspects of this topic. In the following section, we'll examine how to implement custom error types that can provide more granular control over your application's error handling mechanisms.

### Good (human-style)
> The basics work for 80% of cases. But when you need different error responses for different callers (API vs webhook vs internal), you need custom error types.

---

## Conclusions

### Bad (AI-style)
> In conclusion, we've covered a comprehensive overview of error handling patterns in Kotlin. By implementing these strategies, you'll be well-equipped to build robust, maintainable applications. Remember that error handling is not just about catching exceptions — it's about creating a resilient system that gracefully handles the unexpected.

### Good (human-style)
> Three things to remember:
> 1. Return `Either`, don't throw. Your callers will thank you.
> 2. Log the actual error, not a generic message.
> 3. Test the error paths. They run more often than you think.
