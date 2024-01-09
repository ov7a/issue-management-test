const now = new Date();

const labelsToRemoveOnClose = new Set(["to-triage", ":wave: team-triage"]);
const issuesCutoff = new Date(now);
issuesCutoff.setDate(now.getDate() - 7); // 7 days
const issueLabels = new Map([
  ["pending:reproducer", {
    closeLabel: "closed:unreproducible",
    message: "While we asked for a reproducer, none was provided. If you provide a valid reproducer, we will consider this issue again. In the meantime, closing as unreproducible."
  }],
  ["pending:feedback", {
    closeLabel: "closed:missing-feedback",
    message: "While we asked for feedback, none was provided. If you provide the requested feedback, we will consider this issue again. In the meantime, closing as missing feedback."
  }]
]);

const pullsCutoff = new Date(now);
pullsCutoff.setDate(now.getDate() - 14); // 14 days
const pullsLabels = new Map([
  ["pending:dco", {
    closeLabel: "closed:missing-dco",
    message: "While we asked to sign your commits, it has not been done. If you sign your commits, we will consider this pull request again. In the meantime, closing as missing DCO (see the [Developer Certificate of Origin](https://probot.github.io/apps/dco/) GitHub app)."
  }],
  ["pending:feedback", {
    closeLabel: "closed:missing-feedback",
    message: "While we asked for changes to this PR, we received no reaction. If you provide the requested changes, we will consider this pull request again. In the meantime, closing as missing PR feedback."
  }]
]);

const issuesQuery = `query($owner:String!, $name:String!, $labels: [String!]) {
    repository(owner:$owner, name:$name){
      issues(last:100, labels: $labels){
        nodes {
          id, number, updatedAt
          labels(first: 100) {
            nodes { id, name }
          }
          timelineItems(last: 100, itemTypes: [LABELED_EVENT, CLOSED_EVENT, ISSUE_COMMENT, RENAMED_TITLE_EVENT]) {
            nodes {
              __typename
              ... on LabeledEvent {
                createdAt
                label {
                  name
                }
              }
            }
          }
        }
      }
    }
}`;

const pullsQuery = `query($owner:String!, $name:String!, $labels: [String!]) {
    repository(owner:$owner, name:$name){
      pullRequests(last:100, labels: $labels){
        nodes {
          id, number, updatedAt
          labels(first: 100) {
            nodes { id, name }
          }
          timelineItems(last: 100, itemTypes: [
            LABELED_EVENT, BASE_REF_CHANGED_EVENT, CLOSED_EVENT, ISSUE_COMMENT, RENAMED_TITLE_EVENT,
            PULL_REQUEST_COMMIT, PULL_REQUEST_COMMIT_COMMENT_THREAD, PULL_REQUEST_REVIEW_THREAD,
            PULL_REQUEST_REVIEW, PULL_REQUEST_REVISION_MARKER, READY_FOR_REVIEW_EVENT, REVIEW_REQUESTED_EVENT
          ]) {
            nodes {
              __typename
              ... on LabeledEvent {
                createdAt
                label {
                  name
                }
              }
            }
          }
        }
      }
    }
}`;

const commentMutationPart = `
  addComment(input: {subjectId: $itemId, body: $body}) {
    clientMutationId
  }
`;

const addLabelsMutationPart = `
  addLabelsToLabelable(input: {labelableId: $itemId, labelIds: [$closeLabelId]}){
    clientMutationId
  }
`;

const removeLabelsMutationPart = `
  removeLabelsFromLabelable(input: {labelableId: $itemId, labelIds: $labelIds}){
    clientMutationId
  }
`;

const closeIssueMutation = `mutation ($itemId: ID!, $body: String!, $labelIds: [ID!]!, $closeLabelId: ID!) {
  ${commentMutationPart}
  closeIssue(input: {issueId: $itemId, stateReason: NOT_PLANNED}) {
    clientMutationId
  }
  ${addLabelsMutationPart}
  ${removeLabelsMutationPart}
}`;

const closePullMutation = `mutation ($itemId: ID!, $body: String!, $labelIds: [ID!]!, $closeLabelId: ID!) {
  ${commentMutationPart}
  closePullRequest(input: {pullRequestId: $itemId}) {
    clientMutationId
  }
  ${addLabelsMutationPart}
  ${removeLabelsMutationPart}
}`;

const removeLabelsMutation = `mutation ($itemId: ID!, $labelIds: [ID!]!) {
   ${removeLabelsMutationPart}
 }`;

function queryParams(context, feedbackLabels){
    return {owner: context.repo.owner, name: context.repo.repo, labels: Array.from(feedbackLabels.keys())}
}

function wasUpdatedAfterLabeling(events) {
  var hasUpdateEvent = false;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].__typename != "LabeledEvent"){
      hasUpdateEvent = true;
    } else if (events[i].label.name.startsWith("pending:")){
      break;
    }
  }
  return hasUpdateEvent;
}

async function process(github, closedLabelsIds, item, cutoff, feedbackLabels, closeMutation) {
    if (wasUpdatedAfterLabeling(item.timelineItems.nodes)){
        await github.graphql(removeLabelsMutation, {
            itemId: item.id,
            labelIds: item.labels.nodes.filter(label => feedbackLabels.has(label.name)).map(label => label.id)
        });

        console.log(`Removed labels on ${item.number} because it was updated after labeled.`);
    } else if (new Date(item.updatedAt) < cutoff) {
        const mainLabel = item.labels.nodes.find(label => feedbackLabels.has(label.name));

        await github.graphql(closeMutation, {
            itemId: item.id,
            body: feedbackLabels.get(mainLabel.name).message,
            labelIds: item.labels.nodes.filter(label => feedbackLabels.has(label.name) || labelsToRemoveOnClose.has(label.name)).map(label => label.id),
            closeLabelId: closedLabelsIds.get(feedbackLabels.get(mainLabel.name).closeLabel)
        });

        console.log(`Closed ${item.number} because it was last updated on ${item.updatedAt} and had the label ${mainLabel.name}.`);
    }
}

async function getAllClosedLabelIds(github, context){
    const response = await github.graphql(`query{
      repository(owner: "${context.repo.owner}", name: "${context.repo.repo}"){
        labels(first: 100, query: "closed:") {
          nodes {
            id
            name
          }
        }
      }
    }`);
    return new Map(response.repository.labels.nodes.map(label => [label.name, label.id]));
}

module.exports = async ({github, context}) => {
    const closedLabelsIds = await getAllClosedLabelIds(github, context);

    const issuesResult = await github.graphql(issuesQuery, queryParams(context, issueLabels));
    issuesResult.repository.issues.nodes.forEach(issue => process(github, closedLabelsIds, issue, issuesCutoff, issueLabels, closeIssueMutation));

    const pullsResult = await github.graphql(pullsQuery, queryParams(context, pullsLabels));
    pullsResult.repository.pullRequests.nodes.forEach(pullRequest => process(github, closedLabelsIds, pullRequest, pullsCutoff, pullsLabels, closePullMutation));
}