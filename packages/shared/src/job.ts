export type JobProfile = {
  title: string;
  company?: string;
  responsibilities: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  technologies: string[];
  domain: string[];
  keywords: string[];
};

export type JobRequirementMatch = {
  requirement: string;
  /** True if the knowledge base has at least one reasonably relevant chunk for this requirement. */
  matched: boolean;
  /** Names of matching sources (project/CV/etc), best match first. */
  matchingSources: string[];
};

export type StrongestStory = {
  sourceName: string;
  /** How many distinct job requirements this source matched — the ranking signal. */
  matchCount: number;
};

export type StarStory = {
  project: string;
  situation: string;
  task: string;
  action: string;
  result: string;
};

export type JobMatchReport = {
  profile: JobProfile;
  requirementMatches: JobRequirementMatch[];
  likelyQuestions: string[];
  /** Sources (projects/CV) ranked by how many requirements they matched — the candidate's strongest evidence for this role. */
  strongestStories: StrongestStory[];
  /** Requirements with no matching evidence at all — likely gaps to prepare an honest answer for. */
  weakAreas: string[];
  /** STAR-formatted story drafts for the top matched projects. */
  starStories: StarStory[];
};
