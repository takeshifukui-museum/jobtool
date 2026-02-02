export type JobPosting = {
  schemaVersion: string;
  source: string;
  company: { name: string; description?: string };
  position: string;
  job: string;
  requirements: { required?: string[]; preferred?: string[] };
  work: {
    location?: string;
    hours?: string;
    break?: string;
    holidays?: string;
    overtime?: string;
    contract?: string;
  };
  salary: string;
  insurance: string;
  benefits: string;
  selection: string;
  compliance: { notes?: string };
};

export const jobPostingSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "source",
    "company",
    "position",
    "job",
    "requirements",
    "work",
    "salary",
    "insurance",
    "benefits",
    "selection",
    "compliance"
  ],
  properties: {
    schemaVersion: { type: "string" },
    source: { type: "string" },
    company: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string" },
        description: { type: "string" }
      }
    },
    position: { type: "string" },
    job: { type: "string" },
    requirements: {
      type: "object",
      additionalProperties: false,
      properties: {
        required: { type: "array", items: { type: "string" } },
        preferred: { type: "array", items: { type: "string" } }
      }
    },
    work: {
      type: "object",
      additionalProperties: false,
      properties: {
        location: { type: "string" },
        hours: { type: "string" },
        break: { type: "string" },
        holidays: { type: "string" },
        overtime: { type: "string" },
        contract: { type: "string" }
      }
    },
    salary: { type: "string" },
    insurance: { type: "string" },
    benefits: { type: "string" },
    selection: { type: "string" },
    compliance: {
      type: "object",
      additionalProperties: false,
      properties: {
        notes: { type: "string" }
      }
    }
  }
} as const;
