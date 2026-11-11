import type { WorkItem, WorkItemsPoolResponse, MyWorkItemsResponse } from '../types';
import { isWorkItemCompleted } from '../utils/workState';

export const CURRENT_USER_NAME = "Sample User";

export const mockFlatItems: WorkItem[] = [
  // ----------------------------------------------------
  // PROJECT 1: SamplePlatform-Platform
  // ----------------------------------------------------
  {
    id: 1000,
    title: "Sample Platform Capability Initiative",
    type: "Epic",
    state: "Active",
    project: "SamplePlatform-Platform",
    assignedTo: "Fixture Person F",

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: null,
    changedDate: "2026-11-04T09:30:00Z",
    createdDate: "2026-10-15T08:00:00Z",
    priority: 1,
    iteration: "SamplePlatform\\2026.Q4",
    areaPath: "SamplePlatform\\Security",
    description: "Regulatory compliance initiative to implement open banking PSD2 APIs, consent management, and secure customer authentication protocols.",
    url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1000",
    storyPoints: 40,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 1010,
    title: "Sample Access Approval Flow",
    type: "Feature",
    state: "Active",
    project: "SamplePlatform-Platform",
    assignedTo: "Fixture Person F",

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: 1000,
    parentTitle: "Sample Platform Capability Initiative",
    parentType: "Epic",
    changedDate: "2026-11-03T14:15:00Z",
    createdDate: "2026-10-18T10:00:00Z",
    priority: 1,
    iteration: "SamplePlatform\\Sprint 42",
    areaPath: "SamplePlatform\\Security\\OAuth",
    description: "Provide frictionless SCA consent screens with push verification fallback and automated authorization grants.",
    url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1010",
    storyPoints: 21,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 1020,
    title: "Sample Client Redirect Validation",
    type: "User Story",
    state: "Active",
    project: "SamplePlatform-Platform",
    assignedTo: CURRENT_USER_NAME,

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: 1010,
    parentTitle: "Sample Access Approval Flow",
    parentType: "Feature",
    changedDate: "2026-11-04T10:45:00Z",
    createdDate: "2026-10-22T11:20:00Z",
    priority: 1,
    iteration: "SamplePlatform\\Sprint 42",
    areaPath: "SamplePlatform\\Security\\OAuth",
    description: "Implement RFC 7636 Proof Key for Code Exchange (PKCE) with S256 code challenge to prevent authorization code interception on mobile web views.",
    url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1020",
    storyPoints: 8,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 1030,
    title: "Validate Request Nonce and Prevent Replay",
    type: "Task",
    state: "Active",
    project: "SamplePlatform-Platform",
    assignedTo: CURRENT_USER_NAME,

    isUnassigned: false,
    isBug: false,
    isTask: true,
    parentId: 1020,
    parentTitle: "Sample Client Redirect Validation",
    parentType: "User Story",
    changedDate: "2026-11-04T08:15:00Z",
    createdDate: "2026-10-25T09:00:00Z",
    priority: 2,
    iteration: "SamplePlatform\\Sprint 42",
    areaPath: "SamplePlatform\\Security",
    description: "Ensure the token callback verifies SHA-256 state and disposable nonce in distributed cache with 5-minute strict TTL.",
    url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1030",
    relations: {
      predecessors: [
        {
          id: 1031,
          relType: "predecessor",
          relName: "Predecessor",
          comment: "Redis Token Store cluster must be configured first",
          url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1031",
          title: "Configure Distributed Cache Expiration",
          type: "Task",
          state: "Resolved",
          assignedTo: "Fixture Person G",
          isUnassigned: false,
          project: "SamplePlatform-Platform"
        }
      ],
      successors: [
        {
          id: 1040,
          relType: "successor",
          relName: "Successor",
          comment: "Rate limiter relies on the nonce cryptographic verifier",
          url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1040",
          title: "Add request throttling to callback endpoints",
          type: "Task",
          state: "New",
          assignedTo: "",
          isUnassigned: true,
          project: "SamplePlatform-Platform"
        }
      ],
      related: [
        {
          id: 1032,
          relType: "related",
          relName: "Related",
          comment: "Related clock drift bug report",
          url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1032",
          title: "Token validation fails when system clocks drift",
          type: "Bug",
          state: "Active",
          assignedTo: CURRENT_USER_NAME,
          isUnassigned: false,
          project: "SamplePlatform-Platform"
        }
      ],
      total: 3
    },
    children: []
  },
  {
    id: 1031,
    title: "Configure Distributed Cache Expiration",
    type: "Task",
    state: "Resolved",
    project: "SamplePlatform-Platform",
    assignedTo: "Fixture Person G",

    isUnassigned: false,
    isBug: false,
    isTask: true,
    parentId: 1020,
    parentTitle: "Sample Client Redirect Validation",
    parentType: "User Story",
    changedDate: "2026-11-03T16:00:00Z",
    createdDate: "2026-10-24T14:30:00Z",
    priority: 2,
    iteration: "SamplePlatform\\Sprint 42",
    areaPath: "SamplePlatform\\Security",
    description: "Set up multi-region replicated Redis 7.2 cluster with encrypted TLS connection strings and automatic eviction policies.",
    url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1031",
    relations: {
      predecessors: [],
      successors: [
        {
          id: 1030,
          relType: "successor",
          relName: "Successor",
          url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1030",
          title: "Validate Request Nonce and Prevent Replay",
          type: "Task",
          state: "Active",
          assignedTo: CURRENT_USER_NAME,
          isUnassigned: false,
          project: "SamplePlatform-Platform"
        }
      ],
      related: [],
      total: 1
    },
    children: []
  },
  {
    id: 1032,
    title: "Token validation fails when system clocks drift",
    type: "Bug",
    state: "Active",
    project: "SamplePlatform-Platform",
    assignedTo: CURRENT_USER_NAME,

    isUnassigned: false,
    isBug: true,
    isTask: false,
    parentId: 1020,
    parentTitle: "Sample Client Redirect Validation",
    parentType: "User Story",
    changedDate: "2026-11-04T07:20:00Z",
    createdDate: "2026-11-01T11:00:00Z",
    priority: 1,
    iteration: "SamplePlatform\\Sprint 42",
    areaPath: "SamplePlatform\\Security",
    description: "When servers in secondary availability zone experience NTP clock skew exceeding 1.5 seconds, tokens are rejected prematurely with HTTP 401. Need clock leeway buffer.",
    url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1032",
    relations: {
      predecessors: [],
      successors: [],
      related: [
        {
          id: 1030,
          relType: "related",
          relName: "Related",
          url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1030",
          title: "Validate Request Nonce and Prevent Replay",
          type: "Task",
          state: "Active",
          assignedTo: CURRENT_USER_NAME,
          isUnassigned: false,
          project: "SamplePlatform-Platform"
        }
      ],
      total: 1
    },
    children: []
  },
  {
    id: 1040,
    title: "Add request throttling to callback endpoints",
    type: "Task",
    state: "New",
    project: "SamplePlatform-Platform",
    assignedTo: "",
    isUnassigned: true,
    isBug: false,
    isTask: true,
    parentId: 1010,
    parentTitle: "Sample Access Approval Flow",
    parentType: "Feature",
    changedDate: "2026-11-02T10:00:00Z",
    createdDate: "2026-10-28T09:30:00Z",
    priority: 3,
    iteration: "SamplePlatform\\Sprint 42",
    areaPath: "SamplePlatform\\API-Gateway",
    description: "Prevent brute-force callbacks by enforcing 100 req/sec sliding window rate limiting per third-party provider clientId.",
    url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1040",
    relations: {
      predecessors: [
        {
          id: 1030,
          relType: "predecessor",
          relName: "Predecessor",
          url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1030",
          title: "Validate Request Nonce and Prevent Replay",
          type: "Task",
          state: "Active",
          assignedTo: CURRENT_USER_NAME,
          isUnassigned: false,
          project: "SamplePlatform-Platform"
        }
      ],
      successors: [
        {
          id: 1041,
          relType: "successor",
          relName: "Successor",
          url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1041",
          title: "Record throttling events",
          type: "Task",
          state: "New",
          assignedTo: "",
          isUnassigned: true,
          project: "SamplePlatform-Platform"
        }
      ],
      related: [],
      total: 2
    },
    children: []
  },
  {
    id: 1041,
    title: "Record throttling events",
    type: "Task",
    state: "New",
    project: "SamplePlatform-Platform",
    assignedTo: "",
    isUnassigned: true,
    isBug: false,
    isTask: true,
    parentId: 1010,
    parentTitle: "Sample Access Approval Flow",
    parentType: "Feature",
    changedDate: "2026-11-02T11:00:00Z",
    createdDate: "2026-10-28T10:00:00Z",
    priority: 3,
    iteration: "SamplePlatform\\Sprint 42",
    areaPath: "SamplePlatform\\API-Gateway",
    description: "Publish security violation telemetry events to Kafka topic `sec.audit.ratelimit` with IP, client certificate serial, and payload digest.",
    url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1041",
    relations: {
      predecessors: [
        {
          id: 1040,
          relType: "predecessor",
          relName: "Predecessor",
          url: "https://dev.azure.com/example-org/SamplePlatform-Platform/_workitems/edit/1040",
          title: "Add request throttling to callback endpoints",
          type: "Task",
          state: "New",
          assignedTo: "",
          isUnassigned: true,
          project: "SamplePlatform-Platform"
        }
      ],
      successors: [],
      related: [],
      total: 1
    },
    children: []
  },

  // ----------------------------------------------------
  // PROJECT 2: Sample-Mobile-App
  // ----------------------------------------------------
  {
    id: 2000,
    title: "Sample Mobile Sign-in Improvements",
    type: "Epic",
    state: "Active",
    project: "Sample-Mobile-App",
    assignedTo: "Fixture Person H",

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: null,
    changedDate: "2026-11-03T18:00:00Z",
    createdDate: "2026-10-10T09:00:00Z",
    priority: 1,
    iteration: "Mobile\\2026.Q4",
    areaPath: "Mobile\\Core",
    description: "Revamp mobile login experience using hardware Secure Enclave biometric passkeys and smooth 120Hz gesture animations.",
    url: "https://dev.azure.com/example-org/Sample-Mobile-App/_workitems/edit/2000",
    storyPoints: 55,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 2010,
    title: "Passkey Sign-in Module",
    type: "Feature",
    state: "Active",
    project: "Sample-Mobile-App",
    assignedTo: "Fixture Person H",

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: 2000,
    parentTitle: "Sample Mobile Sign-in Improvements",
    parentType: "Epic",
    changedDate: "2026-11-04T09:00:00Z",
    createdDate: "2026-10-14T11:00:00Z",
    priority: 1,
    iteration: "Mobile\\Sprint 18",
    areaPath: "Mobile\\Auth",
    description: "Support passkey synchronization across iCloud Keychain and Google Password Manager for passwordless sign-in.",
    url: "https://dev.azure.com/example-org/Sample-Mobile-App/_workitems/edit/2010",
    storyPoints: 13,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 2020,
    title: "Register a Device with Integrity Check",
    type: "User Story",
    state: "Active",
    project: "Sample-Mobile-App",
    assignedTo: CURRENT_USER_NAME,

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: 2010,
    parentTitle: "Passkey Sign-in Module",
    parentType: "Feature",
    changedDate: "2026-11-04T10:10:00Z",
    createdDate: "2026-10-20T14:00:00Z",
    priority: 1,
    iteration: "Mobile\\Sprint 18",
    areaPath: "Mobile\\Auth",
    description: "Validate iOS DeviceCheck and Android Play Integrity verdict tokens before authorizing passkey registration.",
    url: "https://dev.azure.com/example-org/Sample-Mobile-App/_workitems/edit/2020",
    storyPoints: 5,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 2030,
    title: "Verify Device Signature",
    type: "Task",
    state: "In Progress",
    project: "Sample-Mobile-App",
    assignedTo: CURRENT_USER_NAME,

    isUnassigned: false,
    isBug: false,
    isTask: true,
    parentId: 2020,
    parentTitle: "Register a Device with Integrity Check",
    parentType: "User Story",
    changedDate: "2026-11-04T11:00:00Z",
    createdDate: "2026-10-26T08:00:00Z",
    priority: 2,
    iteration: "Mobile\\Sprint 18",
    areaPath: "Mobile\\Auth",
    description: "Verify elliptic curve P-256 signatures in backend using bouncy castle crypto library.",
    url: "https://dev.azure.com/example-org/Sample-Mobile-App/_workitems/edit/2030",
    relations: {
      predecessors: [],
      successors: [
        {
          id: 2032,
          relType: "successor",
          relName: "Successor",
          comment: "UI faceId prompt triggers after verification endpoint is ready",
          url: "https://dev.azure.com/example-org/Sample-Mobile-App/_workitems/edit/2032",
          title: "Integrate Platform Biometric Prompt",
          type: "Task",
          state: "New",
          assignedTo: "",
          isUnassigned: true,
          project: "Sample-Mobile-App"
        }
      ],
      related: [],
      total: 1
    },
    children: []
  },
  {
    id: 2031,
    title: "Device enrollment fails during biometric prompt",
    type: "Bug",
    state: "Active",
    project: "Sample-Mobile-App",
    assignedTo: "",
    isUnassigned: true,
    isBug: true,
    isTask: false,
    parentId: 2020,
    parentTitle: "Register a Device with Integrity Check",
    parentType: "User Story",
    changedDate: "2026-11-04T06:45:00Z",
    createdDate: "2026-11-02T15:20:00Z",
    priority: 1,
    iteration: "Mobile\\Sprint 18",
    areaPath: "Mobile\\Bugs",
    description: "Fatal exception `SecurityException: KeyStore operation failed` thrown on Galaxy S24 when fingerprint sensor cancellation occurs during prompt display.",
    url: "https://dev.azure.com/example-org/Sample-Mobile-App/_workitems/edit/2031",
    relations: {
      predecessors: [],
      successors: [
        {
          id: 2030,
          relType: "successor",
          relName: "Successor",
          comment: "Blocks verification stability tests",
          url: "https://dev.azure.com/example-org/Sample-Mobile-App/_workitems/edit/2030",
          title: "Verify Device Signature",
          type: "Task",
          state: "In Progress",
          assignedTo: CURRENT_USER_NAME,
          isUnassigned: false,
          project: "Sample-Mobile-App"
        }
      ],
      related: [],
      total: 1
    },
    children: []
  },
  {
    id: 2032,
    title: "Integrate Platform Biometric Prompt",
    type: "Task",
    state: "New",
    project: "Sample-Mobile-App",
    assignedTo: "",
    isUnassigned: true,
    isBug: false,
    isTask: true,
    parentId: 2020,
    parentTitle: "Register a Device with Integrity Check",
    parentType: "User Story",
    changedDate: "2026-11-01T14:00:00Z",
    createdDate: "2026-10-27T10:00:00Z",
    priority: 2,
    iteration: "Mobile\\Sprint 18",
    areaPath: "Mobile\\UI",
    description: "Implement unified cross-platform bridge for biometric sensor prompting with localized fallback messages and passcode alternative.",
    url: "https://dev.azure.com/example-org/Sample-Mobile-App/_workitems/edit/2032",
    relations: {
      predecessors: [
        {
          id: 2030,
          relType: "predecessor",
          relName: "Predecessor",
          url: "https://dev.azure.com/example-org/Sample-Mobile-App/_workitems/edit/2030",
          title: "Verify Device Signature",
          type: "Task",
          state: "In Progress",
          assignedTo: CURRENT_USER_NAME,
          isUnassigned: false,
          project: "Sample-Mobile-App"
        }
      ],
      successors: [],
      related: [],
      total: 1
    },
    children: []
  },

  // ----------------------------------------------------
  // PROJECT 3: Sample-Cloud-Operations
  // ----------------------------------------------------
  {
    id: 3000,
    title: "Improve Multi-Region Service Resilience",
    type: "Epic",
    state: "Active",
    project: "Sample-Cloud-Operations",
    assignedTo: "Fixture Person I",

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: null,
    changedDate: "2026-11-04T08:00:00Z",
    createdDate: "2026-09-30T09:00:00Z",
    priority: 1,
    iteration: "CloudOps\\2026.Q4",
    areaPath: "CloudOps\\Kubernetes",
    description: "Design and implement Active-Active AKS deployment across West Europe and North Europe with Azure Front Door global routing.",
    url: "https://dev.azure.com/example-org/Sample-Cloud-Operations/_workitems/edit/3000",
    storyPoints: 60,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 3010,
    title: "Automate Configuration Synchronization",
    type: "Feature",
    state: "Active",
    project: "Sample-Cloud-Operations",
    assignedTo: "Fixture Person I",

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: 3000,
    parentTitle: "Improve Multi-Region Service Resilience",
    parentType: "Epic",
    changedDate: "2026-11-03T17:30:00Z",
    createdDate: "2026-10-05T12:00:00Z",
    priority: 2,
    iteration: "CloudOps\\Sprint 31",
    areaPath: "CloudOps\\GitOps",
    description: "Enable zero-touch cluster synchronization using declarative repositories with automatic drift detection and notifications.",
    url: "https://dev.azure.com/example-org/Sample-Cloud-Operations/_workitems/edit/3010",
    storyPoints: 18,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 3020,
    title: "Standardize Deployment Templates and Routing",
    type: "Product Backlog Item",
    state: "Active",
    project: "Sample-Cloud-Operations",
    assignedTo: CURRENT_USER_NAME,

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: 3010,
    parentTitle: "Automate Configuration Synchronization",
    parentType: "Feature",
    changedDate: "2026-11-04T11:20:00Z",
    createdDate: "2026-10-18T10:00:00Z",
    priority: 2,
    iteration: "CloudOps\\Sprint 31",
    areaPath: "CloudOps\\Kubernetes",
    description: "Template ingress definitions, automated TLS certificate rotations with cert-manager, and Istio service mesh mTLS policies.",
    url: "https://dev.azure.com/example-org/Sample-Cloud-Operations/_workitems/edit/3020",
    storyPoints: 8,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 3030,
    title: "Configure Automated Certificate Renewal",
    type: "Task",
    state: "Done",
    project: "Sample-Cloud-Operations",
    assignedTo: CURRENT_USER_NAME,

    isUnassigned: false,
    isBug: false,
    isTask: true,
    parentId: 3020,
    parentTitle: "Standardize Deployment Templates and Routing",
    parentType: "Product Backlog Item",
    changedDate: "2026-11-03T12:00:00Z",
    createdDate: "2026-10-22T09:00:00Z",
    priority: 2,
    iteration: "CloudOps\\Sprint 31",
    areaPath: "CloudOps\\Kubernetes",
    description: "Install cert-manager helm chart and setup ClusterIssuer with Azure Managed Identity for wild-card cert issuance.",
    url: "https://dev.azure.com/example-org/Sample-Cloud-Operations/_workitems/edit/3030",
    relations: {
      predecessors: [],
      successors: [
        {
          id: 3031,
          relType: "successor",
          relName: "Successor",
          url: "https://dev.azure.com/example-org/Sample-Cloud-Operations/_workitems/edit/3031",
          title: "Define Resource Quotas & Pod Disruption Budgets",
          type: "Task",
          state: "Active",
          assignedTo: "",
          isUnassigned: true,
          project: "Sample-Cloud-Operations"
        }
      ],
      related: [],
      total: 1
    },
    children: []
  },
  {
    id: 3031,
    title: "Define Resource Limits and Availability Budgets",
    type: "Task",
    state: "Active",
    project: "Sample-Cloud-Operations",
    assignedTo: "",
    isUnassigned: true,
    isBug: false,
    isTask: true,
    parentId: 3020,
    parentTitle: "Standardize Deployment Templates and Routing",
    parentType: "Product Backlog Item",
    changedDate: "2026-11-04T08:30:00Z",
    createdDate: "2026-10-25T11:00:00Z",
    priority: 3,
    iteration: "CloudOps\\Sprint 31",
    areaPath: "CloudOps\\Kubernetes",
    description: "Prevent node starvation during rolling cluster upgrades by configuring strict PDBs (minAvailable: 1) and memory/CPU limits.",
    url: "https://dev.azure.com/example-org/Sample-Cloud-Operations/_workitems/edit/3031",
    relations: {
      predecessors: [
        {
          id: 3030,
          relType: "predecessor",
          relName: "Predecessor",
          url: "https://dev.azure.com/example-org/Sample-Cloud-Operations/_workitems/edit/3030",
          title: "Configure Automated Certificate Renewal",
          type: "Task",
          state: "Done",
          assignedTo: CURRENT_USER_NAME,
          isUnassigned: false,
          project: "Sample-Cloud-Operations"
        }
      ],
      successors: [],
      related: [],
      total: 1
    },
    children: []
  },
  {
    id: 3032,
    title: "Service proxy injection fails for selected network setup",
    type: "Bug",
    state: "New",
    project: "Sample-Cloud-Operations",
    assignedTo: "",
    isUnassigned: true,
    isBug: true,
    isTask: false,
    parentId: 3020,
    parentTitle: "Standardize Deployment Templates and Routing",
    parentType: "Product Backlog Item",
    changedDate: "2026-11-04T10:00:00Z",
    createdDate: "2026-11-03T16:00:00Z",
    priority: 1,
    iteration: "CloudOps\\Sprint 31",
    areaPath: "CloudOps\\Bugs",
    description: "MutatingWebhookConfiguration `istio-sidecar-injector` times out when pods launch in Cilium overlay network with eBPF enabled.",
    url: "https://dev.azure.com/example-org/Sample-Cloud-Operations/_workitems/edit/3032",
    relations: {
      predecessors: [],
      successors: [],
      related: [
        {
          id: 3031,
          relType: "related",
          relName: "Related",
          url: "https://dev.azure.com/example-org/Sample-Cloud-Operations/_workitems/edit/3031",
          title: "Define Resource Quotas & Pod Disruption Budgets",
          type: "Task",
          state: "Active",
          assignedTo: "",
          isUnassigned: true,
          project: "Sample-Cloud-Operations"
        }
      ],
      total: 1
    },
    children: []
  },

  // ----------------------------------------------------
  // PROJECT 4: Sample-Payment-Service
  // ----------------------------------------------------
  {
    id: 4000,
    title: "Sample Secure Payment Data Architecture",
    type: "Epic",
    state: "Active",
    project: "Sample-Payment-Service",
    assignedTo: "Fixture Person J",

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: null,
    changedDate: "2026-11-02T15:00:00Z",
    createdDate: "2026-09-15T09:00:00Z",
    priority: 1,
    iteration: "Payment\\2026.Q4",
    areaPath: "Payment\\Vault",
    description: "Comply with new PCI-DSS v4 requirements for tokenized primary account number (PAN) storage and HSM key rotation.",
    url: "https://dev.azure.com/example-org/Sample-Payment-Service/_workitems/edit/4000",
    storyPoints: 50,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 4010,
    title: "Encrypt Stored Payment Tokens",
    type: "Feature",
    state: "Active",
    project: "Sample-Payment-Service",
    assignedTo: "Fixture Person J",

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: 4000,
    parentTitle: "Sample Secure Payment Data Architecture",
    parentType: "Epic",
    changedDate: "2026-11-03T11:00:00Z",
    createdDate: "2026-09-20T10:00:00Z",
    priority: 1,
    iteration: "Payment\\Sprint 12",
    areaPath: "Payment\\Security",
    description: "Implement two-tier envelope encryption: Root Key stored in Azure Dedicated HSM, Data Encryption Keys generated per transaction.",
    url: "https://dev.azure.com/example-org/Sample-Payment-Service/_workitems/edit/4010",
    storyPoints: 15,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 4020,
    title: "Validate Sample Payment Identifiers",
    type: "User Story",
    state: "Active",
    project: "Sample-Payment-Service",
    assignedTo: CURRENT_USER_NAME,

    isUnassigned: false,
    isBug: false,
    isTask: false,
    parentId: 4010,
    parentTitle: "Encrypt Stored Payment Tokens",
    parentType: "Feature",
    changedDate: "2026-11-04T09:50:00Z",
    createdDate: "2026-10-10T14:00:00Z",
    priority: 1,
    iteration: "Payment\\Sprint 12",
    areaPath: "Payment\\Services",
    description: "High-throughput in-memory lookup table for 8-digit BIN ranges to determine card brand, issuing country, and 3D-Secure 2.2 routing rules.",
    url: "https://dev.azure.com/example-org/Sample-Payment-Service/_workitems/edit/4020",
    storyPoints: 5,
    relations: { predecessors: [], successors: [], related: [], total: 0 },
    children: []
  },
  {
    id: 4030,
    title: "Optimize Prefix Lookup for Payment Identifiers",
    type: "Task",
    state: "Active",
    project: "Sample-Payment-Service",
    assignedTo: CURRENT_USER_NAME,

    isUnassigned: false,
    isBug: false,
    isTask: true,
    parentId: 4020,
    parentTitle: "Validate Sample Payment Identifiers",
    parentType: "User Story",
    changedDate: "2026-11-04T10:30:00Z",
    createdDate: "2026-10-28T09:00:00Z",
    priority: 2,
    iteration: "Payment\\Sprint 12",
    areaPath: "Payment\\Services",
    description: "Benchmark Radix Trie vs HashMap lookup latency to maintain p99 under 0.8ms during 10k transactions/sec spikes.",
    url: "https://dev.azure.com/example-org/Sample-Payment-Service/_workitems/edit/4030",
    relations: {
      predecessors: [],
      successors: [
        {
          id: 4032,
          relType: "successor",
          relName: "Successor",
          url: "https://dev.azure.com/example-org/Sample-Payment-Service/_workitems/edit/4032",
          title: "Publish Lookup Latency Metrics",
          type: "Task",
          state: "New",
          assignedTo: "",
          isUnassigned: true,
          project: "Sample-Payment-Service"
        }
      ],
      related: [],
      total: 1
    },
    children: []
  },
  {
    id: 4031,
    title: "Payment identifier prefix mapped to an unexpected category",
    type: "Bug",
    state: "Active",
    project: "Sample-Payment-Service",
    assignedTo: "",
    isUnassigned: true,
    isBug: true,
    isTask: false,
    parentId: 4020,
    parentTitle: "Validate Sample Payment Identifiers",
    parentType: "User Story",
    changedDate: "2026-11-04T07:10:00Z",
    createdDate: "2026-11-02T12:00:00Z",
    priority: 1,
    iteration: "Payment\\Sprint 12",
    areaPath: "Payment\\Bugs",
    description: "Cards beginning with 2221-2720 are rejected on debit routing because parser flags them as legacy Maestro instead of standard Mastercard debit.",
    url: "https://dev.azure.com/example-org/Sample-Payment-Service/_workitems/edit/4031",
    relations: {
      predecessors: [],
      successors: [
        {
          id: 4030,
          relType: "successor",
          relName: "Successor",
          comment: "BIN fix required before Radix Trie final test",
          url: "https://dev.azure.com/example-org/Sample-Payment-Service/_workitems/edit/4030",
          title: "Optimize Prefix Lookup for Payment Identifiers",
          type: "Task",
          state: "Active",
          assignedTo: CURRENT_USER_NAME,
          isUnassigned: false,
          project: "Sample-Payment-Service"
        }
      ],
      related: [],
      total: 1
    },
    children: []
  },
  {
    id: 4032,
    title: "Publish Lookup Latency Metrics",
    type: "Task",
    state: "New",
    project: "Sample-Payment-Service",
    assignedTo: "",
    isUnassigned: true,
    isBug: false,
    isTask: true,
    parentId: 4020,
    parentTitle: "Validate Sample Payment Identifiers",
    parentType: "User Story",
    changedDate: "2026-11-01T15:00:00Z",
    createdDate: "2026-10-29T11:00:00Z",
    priority: 3,
    iteration: "Payment\\Sprint 12",
    areaPath: "Payment\\Observability",
    description: "Expose `payment_bin_lookup_duration_seconds` buckets with labels for card brand and cache hit/miss.",
    url: "https://dev.azure.com/example-org/Sample-Payment-Service/_workitems/edit/4032",
    relations: {
      predecessors: [
        {
          id: 4030,
          relType: "predecessor",
          relName: "Predecessor",
          url: "https://dev.azure.com/example-org/Sample-Payment-Service/_workitems/edit/4030",
          title: "Optimize Prefix Lookup for Payment Identifiers",
          type: "Task",
          state: "Active",
          assignedTo: CURRENT_USER_NAME,
          isUnassigned: false,
          project: "Sample-Payment-Service"
        }
      ],
      successors: [],
      related: [],
      total: 1
    },
    children: []
  }
];

// Build nested hierarchy tree from flat items
export function buildHierarchyTree(items: WorkItem[]): WorkItem[] {
  const itemMap = new Map<number, WorkItem>();

  // Clone items to avoid mutating originals
  items.forEach(item => {
    itemMap.set(item.id, { ...item, children: [] });
  });

  const rootItems: WorkItem[] = [];

  itemMap.forEach(item => {
    // Determine blocked status using centralized completion rules
    const hasUnresolvedPredecessor = item.relations.predecessors.some(
      p => !isWorkItemCompleted(p.state || '', p.type || '')
    );
    item.isBlocked = hasUnresolvedPredecessor;
    item.isBlocking = item.relations.successors.length > 0;

    if (item.parentId && itemMap.has(item.parentId)) {
      const parent = itemMap.get(item.parentId)!;
      parent.children.push(item);
    } else {
      rootItems.push(item);
    }
  });

  return rootItems;
}

export function generateMockPoolResponse(): WorkItemsPoolResponse {
  const items = mockFlatItems.map(item => {
    const hasUnresolvedPredecessor = item.relations.predecessors.some(
      p => !isWorkItemCompleted(p.state || '', p.type || '')
    );
    return {
      ...item,
      isBlocked: hasUnresolvedPredecessor,
      isBlocking: item.relations.successors.length > 0
    };
  });

  const projects = Array.from(new Set(items.map(i => i.project))).sort();

  const stats_by_project: Record<string, any> = {};
  projects.forEach(p => {
    const pItems = items.filter(i => i.project === p);
    stats_by_project[p] = {
      total: pItems.length,
      unassigned: pItems.filter(i => i.isUnassigned).length,
      unassigned_bugs: pItems.filter(i => i.isUnassigned && i.isBug).length,
      unassigned_tasks: pItems.filter(i => i.isUnassigned && i.isTask).length,
      assigned: pItems.filter(i => !i.isUnassigned).length,
    };
  });

  const hierarchy = buildHierarchyTree(items);

  return {
    summary: {
      total_items: items.length,
      unassigned_total: items.filter(i => i.isUnassigned).length,
      unassigned_tasks: items.filter(i => i.isUnassigned && i.isTask).length,
      unassigned_bugs: items.filter(i => i.isUnassigned && i.isBug).length,
      assigned_total: items.filter(i => !i.isUnassigned).length,
      pbi_count: hierarchy.length,
    },
    stats_by_project,
    hierarchy,
    flat_items: items,
    projects
  };
}

export function generateMockMyWorkItems(): MyWorkItemsResponse {
  const myItems = mockFlatItems
    .filter(i => i.assignedTo === CURRENT_USER_NAME)
    .map(i => ({
      id: i.id,
      title: i.title,
      type: i.type,
      state: i.state,
      project: i.project,
      assignedTo: i.assignedTo,
      changedDate: i.changedDate,
      url: i.url
    }));

  return {
    work_items: myItems,
    count: myItems.length
  };
}
