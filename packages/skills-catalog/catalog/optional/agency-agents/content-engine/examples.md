# Content Engine — Platform Examples

> Read these examples to understand what platform-native content looks like. Same idea, different format per platform.

## Source Idea
**"We shipped a feature that reduced API response time from 800ms to 120ms by adding a Redis cache layer."**

---

## X (Twitter) — Single Post
> We cut our API response time from 800ms to 120ms.
>
> The fix: Redis cache in front of our heaviest query.
>
> Took 2 hours to implement. Should've done it 6 months ago.

**Why this works:** Specific numbers. Self-deprecating honesty. No hashtags.

### Bad Version
> 🚀 Excited to share that we've optimized our API performance! By leveraging Redis caching, we've achieved significant improvements in response times. #DevOps #Performance #Redis #Optimization

**Why this fails:** Emoji rocket, "excited to share", vague ("significant"), hashtag spam.

---

## X (Twitter) — Thread
> **1/** Our API was taking 800ms per request. Users were complaining. Here's the 2-hour fix that got us to 120ms.
>
> **2/** The problem: our /dashboard endpoint hits 6 tables, joins 3 of them, and runs a GROUP BY. On every. single. request.
>
> **3/** The fix: Redis cache with 60-second TTL. Dashboard data doesn't change that often. Users don't need real-time accuracy on a summary screen.
>
> **4/** Results after 1 week:
> - p99 latency: 800ms → 120ms
> - DB CPU: 78% → 31%
> - User complaints about "slow dashboard": 0
>
> **5/** Should we have done this earlier? Obviously. But we were busy building features nobody used. That's a different thread.

---

## LinkedIn Post
> Last week I spent 2 hours on a fix that should've happened 6 months ago.
>
> Our API dashboard endpoint was taking 800ms. Users were complaining, but we kept prioritizing new features.
>
> The fix was embarrassingly simple: Redis cache with a 60-second TTL.
>
> Results:
> → Response time: 800ms → 120ms
> → Database CPU: 78% → 31%
> → User complaints: gone
>
> The lesson isn't about Redis. It's about how easy it is to ignore performance problems when you're "too busy building."
>
> Sometimes the most impactful work is the boring work.

**Why this works:** Personal story, specific numbers, lesson at the end, short paragraphs.

### Bad Version
> 🎉 Thrilled to announce that our engineering team has achieved a remarkable 85% improvement in API performance! This milestone demonstrates our commitment to delivering exceptional user experiences. We leveraged cutting-edge caching technology to optimize our infrastructure. #Engineering #Innovation #TechLeadership

**Why this fails:** "Thrilled to announce", "remarkable", "commitment to delivering", hashtags, no specifics.

---

## Newsletter Blurb
> **This week's win: 2-hour fix, 6x faster API**
>
> Our dashboard was slow (800ms). Turned out the endpoint was hitting 6 tables on every request. Added a Redis cache with a 60-second TTL. Now it's 120ms.
>
> Lesson: before you build the next feature, check if the last one actually works well.
