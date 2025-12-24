# SDK

## Example
Below is a stable code block that should never be split across chunks.

```ts
import { createClient } from "@memento/sdk";

const client = createClient({
  baseUrl: "http://localhost:8080",
  apiKey: "test-key",
});

await client.memory.search({ query: "token refresh" });
```

The paragraph after the code fence should remain with the section.

## Notes
Use short-lived tokens for local development only.
