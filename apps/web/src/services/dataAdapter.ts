import type { WorkItem, WorkItemsPoolResponse, MyWorkItemsResponse, RelationItem } from '../types';
import { buildHierarchyTree } from '../utils/hierarchy';
import { evaluateItemBlockedStatus } from '../utils/dependencyEngine';

/**
 * Normalizes raw Work Item relations from Azure DevOps API or backend JSON.
 */
function normalizeRelations(rawRelations: any, orgUrl: string): {
  predecessors: RelationItem[];
  successors: RelationItem[];
  related: RelationItem[];
  total: number;
} {
  const predecessors: RelationItem[] = [];
  const successors: RelationItem[] = [];
  const related: RelationItem[] = [];

  if (!rawRelations) {
    return { predecessors, successors, related, total: 0 };
  }

  // Handle already categorized relations { predecessors, successors, related }
  if (Array.isArray(rawRelations.predecessors)) {
    for (const p of rawRelations.predecessors) {
      if (p && p.id) {
        predecessors.push({
          id: Number(p.id),
          relType: 'predecessor',
          relName: p.relName || 'Predecessor',
          comment: p.comment || '',
          url: p.url || `${orgUrl}/_workitems/edit/${p.id}`,
          title: p.title,
          type: p.type,
          state: p.state,
          assignedTo: p.assignedTo,
          isUnassigned: p.isUnassigned ?? (!p.assignedTo),
          project: p.project
        });
      }
    }
  }

  if (Array.isArray(rawRelations.successors)) {
    for (const s of rawRelations.successors) {
      if (s && s.id) {
        successors.push({
          id: Number(s.id),
          relType: 'successor',
          relName: s.relName || 'Successor',
          comment: s.comment || '',
          url: s.url || `${orgUrl}/_workitems/edit/${s.id}`,
          title: s.title,
          type: s.type,
          state: s.state,
          assignedTo: s.assignedTo,
          isUnassigned: s.isUnassigned ?? (!s.assignedTo),
          project: s.project
        });
      }
    }
  }

  if (Array.isArray(rawRelations.related)) {
    for (const r of rawRelations.related) {
      if (r && r.id) {
        related.push({
          id: Number(r.id),
          relType: 'related',
          relName: r.relName || 'Related',
          comment: r.comment || '',
          url: r.url || `${orgUrl}/_workitems/edit/${r.id}`,
          title: r.title,
          type: r.type,
          state: r.state,
          assignedTo: r.assignedTo,
          isUnassigned: r.isUnassigned ?? (!r.assignedTo),
          project: r.project
        });
      }
    }
  }

  // Handle raw Azure DevOps array format [{ rel, url, attributes: { name, comment } }]
  if (Array.isArray(rawRelations)) {
    for (const r of rawRelations) {
      const relUrl = r.url || '';
      const relType = r.rel || '';
      const attr = r.attributes || {};
      const relName = attr.name || relType;
      const comment = attr.comment || '';

      const matchId = relUrl.match(/workItems\/(\d+)$/i);
      const targetId = matchId ? Number(matchId[1]) : (r.id ? Number(r.id) : null);

      if (targetId) {
        const entry: RelationItem = {
          id: targetId,
          relType: 'other',
          relName,
          comment,
          url: `${orgUrl}/_workitems/edit/${targetId}`,
          title: r.title,
          type: r.type,
          state: r.state,
          assignedTo: r.assignedTo,
          isUnassigned: r.isUnassigned,
          project: r.project
        };

        if (relType === 'System.LinkTypes.Dependency-Reverse' || relName === 'Predecessor') {
          entry.relType = 'predecessor';
          entry.relName = 'Predecessor';
          predecessors.push(entry);
        } else if (relType === 'System.LinkTypes.Dependency-Forward' || relName === 'Successor') {
          entry.relType = 'successor';
          entry.relName = 'Successor';
          successors.push(entry);
        } else if (relType === 'System.LinkTypes.Related' || relName === 'Related') {
          entry.relType = 'related';
          entry.relName = 'Related';
          related.push(entry);
        }
      }
    }
  }

  return {
    predecessors,
    successors,
    related,
    total: predecessors.length + successors.length + related.length
  };
}

/**
 * Robustly adapts live API responses from AzureDashboard / Azure DevOps into
 * the DevOpsFlow WorkItem model.
 *
 * Guarantees:
 * - Deduplication of items by ID.
 * - Accurate evaluation of isBlocked and isBlocking flags.
 * - Parent enrichment (parentTitle, parentType).
 * - Safe handling of missing/null fields without hallucinating data.
 * - Clean hierarchical tree construction.
 */
export function adaptLiveWorkItemsPool(
  rawResponse: any,
  baseUrl: string = 'https://dev.azure.com',
  myWorkItemsList: any[] = []
): WorkItemsPoolResponse {
  if (!rawResponse || typeof rawResponse !== 'object') {
    throw new Error('Invalid API response: payload is not an object.');
  }

  // Extract raw items list
  const rawList: any[] = Array.isArray(rawResponse.flat_items)
    ? rawResponse.flat_items
    : Array.isArray(rawResponse.workItems)
    ? rawResponse.workItems
    : Array.isArray(rawResponse.value)
    ? rawResponse.value
    : [];

  const itemMap = new Map<number, WorkItem>();
  const projectsSet = new Set<string>();

  // Ingest all projects returned by organization
  if (Array.isArray(rawResponse.projects)) {
    for (const p of rawResponse.projects) {
      if (typeof p === 'string' && p.trim()) {
        projectsSet.add(p.trim());
      }
    }
  }

  // Combine raw pool items with any distinct my-work-items
  const combinedList = [...rawList];
  if (Array.isArray(myWorkItemsList)) {
    for (const m of myWorkItemsList) {
      if (m && m.id && !combinedList.some(r => r.id === m.id)) {
        combinedList.push(m);
      }
    }
  }

  // Pass 1: Parse and deduplicate raw items
  for (const raw of combinedList) {
    if (!raw || (!raw.id && !raw.System_Id)) continue;
    const id = Number(raw.id || raw.System_Id);
    if (!id || itemMap.has(id)) continue; // Deduplicate

    const fields = raw.fields || {};

    const title: string = (
      raw.title ||
      fields['System.Title'] ||
      `Work Item #${id}`
    ).trim();

    const type: string = (
      raw.type ||
      fields['System.WorkItemType'] ||
      'Task'
    ).trim();

    const state: string = (
      raw.state ||
      fields['System.State'] ||
      'Active'
    ).trim();

    const project: string = (
      raw.project ||
      fields['System.TeamProject'] ||
      'General'
    ).trim();

    projectsSet.add(project);

    // Assignee normalization
    let assignedTo = '';
    let assignedAvatar: string | undefined = undefined;

    const rawAssigned = raw.assignedTo ?? fields['System.AssignedTo'];
    if (rawAssigned) {
      if (typeof rawAssigned === 'string') {
        assignedTo = rawAssigned.trim();
      } else if (typeof rawAssigned === 'object') {
        assignedTo = rawAssigned.displayName || rawAssigned.name || '';
        assignedAvatar = rawAssigned._links?.avatar?.href || rawAssigned.imageUrl;
      }
    }
    if (raw.assignedAvatar) {
      assignedAvatar = raw.assignedAvatar;
    }

    const isUnassigned = !assignedTo || assignedTo.toLowerCase() === 'unassigned';
    const isBug = type.toLowerCase().includes('bug');
    const isTask = type.toLowerCase().includes('task');

    // Priority normalization (1, 2, 3, 4)
    let priority = 3;
    const rawPriority = raw.priority ?? fields['Microsoft.VSTS.Common.Priority'];
    if (typeof rawPriority === 'number' && rawPriority >= 1 && rawPriority <= 4) {
      priority = rawPriority;
    } else if (typeof rawPriority === 'string') {
      const parsedP = parseInt(rawPriority, 10);
      if (!isNaN(parsedP) && parsedP >= 1 && parsedP <= 4) {
        priority = parsedP;
      }
    }

    // Parent normalization
    let parentId: number | null = null;
    const rawParent = raw.parentId ?? fields['System.Parent'];
    if (rawParent && !isNaN(Number(rawParent))) {
      parentId = Number(rawParent);
    }

    // Story Points
    let storyPoints: number | undefined = undefined;
    const rawSP = raw.storyPoints ?? fields['Microsoft.VSTS.Scheduling.StoryPoints'];
    if (typeof rawSP === 'number' && !isNaN(rawSP)) {
      storyPoints = rawSP;
    }

    const changedDate: string = raw.changedDate || fields['System.ChangedDate'] || new Date().toISOString();
    const createdDate: string | undefined = raw.createdDate || fields['System.CreatedDate'] || undefined;
    const iteration: string | undefined = raw.iteration || fields['System.IterationPath'] || undefined;
    const areaPath: string | undefined = raw.areaPath || fields['System.AreaPath'] || undefined;
    const description: string | undefined = raw.description || fields['System.Description'] || undefined;
    const url: string = raw.url || `${baseUrl}/${project}/_workitems/edit/${id}`;

    // Normalize relations
    const relations = normalizeRelations(raw.relations || raw.relations_raw, baseUrl);

    itemMap.set(id, {
      id,
      title,
      type,
      state,
      project,
      assignedTo: isUnassigned ? 'Unassigned' : assignedTo,
      assignedAvatar,
      isUnassigned,
      isBug,
      isTask,
      parentId,
      changedDate,
      createdDate,
      priority,
      iteration,
      areaPath,
      description,
      url,
      storyPoints,
      relations,
      children: []
    });
  }

  // Pass 2: Cross-item enrichment (Parent title & type, Relation targets, Blocked status)
  for (const item of itemMap.values()) {
    // Parent enrichment
    if (item.parentId && itemMap.has(item.parentId)) {
      const parent = itemMap.get(item.parentId)!;
      item.parentTitle = parent.title;
      item.parentType = parent.type;
    }

    // Predecessor / Successor metadata enrichment
    for (const p of item.relations.predecessors) {
      if (itemMap.has(p.id)) {
        const target = itemMap.get(p.id)!;
        p.title = target.title;
        p.type = target.type;
        p.state = target.state;
        p.assignedTo = target.assignedTo;
        p.project = target.project;
      }
    }
    for (const s of item.relations.successors) {
      if (itemMap.has(s.id)) {
        const target = itemMap.get(s.id)!;
        s.title = target.title;
        s.type = target.type;
        s.state = target.state;
        s.assignedTo = target.assignedTo;
        s.project = target.project;
      }
    }

    // Evaluate blocked status
    const blockedEval = evaluateItemBlockedStatus(item, itemMap);
    item.isBlocked = blockedEval.isBlocked;
    item.isBlocking = blockedEval.isBlocking;
  }

  const flatItems = Array.from(itemMap.values());

  // Pass 3: Hierarchy Tree Construction
  const hierarchy = buildHierarchyTree(flatItems);

  // Pass 4: Project statistics & overall summary
  const statsByProject: Record<string, {
    total: number;
    unassigned: number;
    unassigned_bugs: number;
    unassigned_tasks: number;
    assigned: number;
  }> = {};

  let unassignedTotal = 0;
  let unassignedTasks = 0;
  let unassignedBugs = 0;
  let assignedTotal = 0;

  for (const item of flatItems) {
    if (!statsByProject[item.project]) {
      statsByProject[item.project] = {
        total: 0,
        unassigned: 0,
        unassigned_bugs: 0,
        unassigned_tasks: 0,
        assigned: 0
      };
    }
    const stat = statsByProject[item.project];
    stat.total++;
    if (item.isUnassigned) {
      stat.unassigned++;
      unassignedTotal++;
      if (item.isBug) {
        stat.unassigned_bugs++;
        unassignedBugs++;
      } else {
        stat.unassigned_tasks++;
        unassignedTasks++;
      }
    } else {
      stat.assigned++;
      assignedTotal++;
    }
  }

  return {
    summary: {
      total_items: flatItems.length,
      loaded_items: flatItems.length,
      total_active_in_org: rawResponse.summary?.total_active_in_org || flatItems.length,
      unassigned_total: unassignedTotal,
      unassigned_tasks: unassignedTasks,
      unassigned_bugs: unassignedBugs,
      assigned_total: assignedTotal,
      pbi_count: hierarchy.length
    },
    stats_by_project: statsByProject,
    hierarchy,
    flat_items: flatItems,
    projects: Array.from(projectsSet).sort()
  };
}

/**
 * Adapts live response from /api/my-work-items safely.
 */
export function adaptLiveMyWorkItems(rawResponse: any): MyWorkItemsResponse {
  if (!rawResponse || typeof rawResponse !== 'object') {
    return { work_items: [], count: 0 };
  }

  const rawList: any[] = Array.isArray(rawResponse.work_items)
    ? rawResponse.work_items
    : Array.isArray(rawResponse.value)
    ? rawResponse.value
    : [];

  const items = rawList.map((raw: any) => ({
    id: Number(raw.id),
    title: String(raw.title || `Work Item #${raw.id}`),
    type: String(raw.type || 'Task'),
    state: String(raw.state || 'Active'),
    project: String(raw.project || 'General'),
    assignedTo: String(raw.assignedTo || ''),
    changedDate: String(raw.changedDate || new Date().toISOString()),
    url: String(raw.url || '')
  })).filter(i => !isNaN(i.id));

  return {
    work_items: items,
    count: items.length
  };
}
