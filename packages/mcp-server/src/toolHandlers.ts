/**
 * ToolHandlers is the narrow interface expected by registerTools().
 * Each handler should:
 * - Validate / normalize the project context (active project)
 * - Perform a single transaction for write tools
 * - Return a JSON-serializable object matching the corresponding Output schema
 */
export type ToolHandlers = {
  projectsResolve: (input: any) => Promise<any>;
  projectsList: (input: any) => Promise<any>;

  sessionsStart: (input: any) => Promise<any>;
  sessionsEnd: (input: any) => Promise<any>;

  embeddingProfilesList: (input: any) => Promise<any>;
  embeddingProfilesUpsert: (input: any) => Promise<any>;
  embeddingProfilesActivate: (input: any) => Promise<any>;

  memoryCommit: (input: any) => Promise<any>;
  memoryGet: (input: any) => Promise<any>;
  memorySearch: (input: any) => Promise<any>;
  memoryRestore: (input: any) => Promise<any>;
  memoryHistory: (input: any) => Promise<any>;
  memoryDiff: (input: any) => Promise<any>;
  memoryPin: (input: any) => Promise<any>;
  memoryUnpin: (input: any) => Promise<any>;
  memoryLink: (input: any) => Promise<any>;
  memoryArchive: (input: any) => Promise<any>;

  canonicalUpsert: (input: any) => Promise<any>;
  canonicalGet: (input: any) => Promise<any>;
  canonicalOutline: (input: any) => Promise<any>;
  canonicalGetSection: (input: any) => Promise<any>;
  canonicalContextPack: (input: any) => Promise<any>;

  adminReindexProfile: (input: any) => Promise<any>;
  adminReingestVersion: (input: any) => Promise<any>;
  healthCheck: (input: any) => Promise<any>;
};
