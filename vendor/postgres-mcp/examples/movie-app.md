## Movie Ratings Website

Let's do a quick AI-coding session and take an idea from concept to launch!

We'll use the [IMDB dataset](https://developer.imdb.com/non-commercial-datasets/) to build a movie ratings website.

**Our AI tools:**
- **Replit** - for the initial prototype
- **Cursor** - as our AI coding agent
- **Postgres Pro** - to give Cursor a Postgres expert

**What we did:**
1) Create the initial app on Replit - it's slow!
2) Fixed performance - including ORM queries, indexing, and caching
3) Fixed an empty movie details pages
4) Improved the sort for top-rated movies

**Full Video**

*(play-by-play walkthrough is below)*

https://github.com/user-attachments/assets/24e05745-65e9-4998-b877-a368f1eadc13

---

**Let's get started...**

<table>
  <tbody>
    <tr>
      <td align="left" valign="top">
        <h4>1) Create the initial app on Replit</h4>
        <p>We prompt Replit with:</p>
        <blockquote>
          <p>Create a web app based on flask, python and SQAlchemy ORM</p>
          <p>It's website that uses the schema from the public IMDB dataset . Assume I've imported the IMDB dataset as-is and add to that. I want people to be able to browse a mobile-friendly page for each movie, with all the IMDB data related to that movie. Additionally, people can rate each movie 1-5 and view top rated movies. The community and these ratings are one of the primary uses cases for the website.</p>
        </blockquote>
        <p><b>Boom!</b> We have a fully functional website with ratings, search, browse, auth -- in under an hour.  What!!  So cool.</p>
        <p><b>But it's slooooow...</b></br>
        The AI agent created a bunch of ORM code and what looked like reasonable indexes, but clearly it got it wrong.</p>
    </td>
      <td align="center"><a href="https://youtu.be/v09nxLF3QKI"><img src="https://github.com/user-attachments/assets/2609dfcb-2ff3-45b9-89f1-6d991e65c461"/></a></td>
    </tr>
    <tr>
      <td align="left" valign="top">
        <h4>2) Fix query performance</h4>
        <p>Our website looks decent, but it's too slow to ship.<br/>
        Let's switch to Cursor w/ Postgres Pro to get the app ready for launch.</p>
        <p>Our prompt:</p>
        <blockquote>
          <div>My app is slow!</div>
          <div>- Look for opportunities to speed up by improving queries, indexes or caching.</div>
          <div>- For db changes use migration scripts I can apply later.</div>
        </blockquote>
        <p>Let's see what all the AI agent did.</p>
        <ol>
          <li>Explored the schema and code to identify potential problem queries</li>
          <li>Used Postgres Pro to diagnose by calling <code>get_top_queries</code>, <code>analyze_db_health</code>, and <code>analyze_query_indexes</code></li>
          <li>Added multiple indexes to improve query performance</li>
          <li>Remove unused and bloated indexes to reclaim space</li>
          <li>Added caching for expensive queries and image loading</li>
          <li>Created a migration script to apply the changes</li>
        </ol>
        <p>That was amazing! The agent was able to connect the dots between the database analysis and the code to create a comprehensive PR in 2.5 minutes.</p>
        <div>It summarized the expected impact:</div>
        <ul>
          <li>Text searches will be 10-100x faster</li>
          <li>Page loads will be 2-5x faster</li>
          <li>Database load will be significantly reduced</li>
          <li>External API calls will be reduced by ~90%</li>
        </ul>
      </td>
      <td align="center"><a href="https://youtu.be/v09nxLF3QKI?t=42"><img src="https://github.com/user-attachments/assets/3e9cdd1d-e93e-4e4a-a043-ffdc6f4feea6"/></a></td>
    </tr>
    <tr>
      <td align="left" valign="top">
        <h4>3) Fix empty movie details pages</h4>
        <p>The movie details looks empty. Let's investigate.</p>
        <blockquote>
          <div>The movie details page looks awful.</div>
          <div>- no cast/crew. Are we missing the data or is the query wrong?</div>
          <div>- The ratings looks misplaced. move it closer to the title</div>
          <div>- Do we have additional data we can include like a description? Check the schema.</div>
        </blockquote>
        <div>The result?</div>
        <ol>
          <li>It used Postgres Pro to inspect the schema and compare it against the code.</li>
          <li>It fixed the query in the route to join with <code>name_basics</code>.</li>
          <li>It identified additional data in <code>title_basics</code>
          to create a new About section with genre, runtime, and release years.</li>
        </ol>
        Let's ask:
        <blockquote>Am I missing any data?</blockquote>
        <p>The AI Agent runs the sql queries and figures out we are indeed missing the cast/crew data.  It writes a script to import it in a more reliable way.</p>
        <div><em>(it turned out my original script aborted on errors)</em></p>
      </td>
      <td align="center">
        <a href="https://youtu.be/v09nxLF3QKI?t=184"><img src="https://github.com/user-attachments/assets/a5727fd5-3845-4110-998d-5af4f386ce0e"/></a>
      </td>
    </tr>
    <tr>
      <td align="left" valign="top">
        <h4>4) Improve the sort for top-rated movies</h4>
        <p>The top-rated page is showing the classics like "Sisters of the Shrink 4" and "Zhuchok", etc. Something is wrong!</p>
        <blockquote>
          <div>How are the top-rated sorted?  It seems random.
          Do we have data in those tables?  Is the query it uses working?</div>
        </blockquote>
        <div>The Agent checks the data and code dentifies that the issue is there is no minimum on the <code>num_votes</code></div>
        <br/>
        <div>So I ask:</div>
        <blockquote>
          <div>help me find a good minimum of reviews</div>
        </blockquote>
        <div>The AI Agent gets the distribution of data and some sample results to determine that a 10K vote minimum would give the best results.  It's great seeing the results are grounded in reality and not just some hallucination.</div>
      </td>
      <td align="center">
        <a href="https://youtu.be/v09nxLF3QKI?t=327"><img src="https://github.com/user-attachments/assets/05af6f5d-326c-4976-8719-20d4dcb6712c"/></a>
      </td>
    </tr>
  </tbody>
</table>

## Want to learn more?

- [Overview](../README.md#overview)
- [Features](../README.md#features)
- [Quick Start](../README.md#quick-start)
- [Technical Notes](../README.md#technical-notes)
- [Discord Server](https://discord.gg/4BEHC7ZM)
