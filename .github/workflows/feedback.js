const labelsToRemoveOnClose = new Set(["to-triage", ":wave: team-triage"]);
const issuesCutoff = new Date(new Date().getDate() - 1); // 7 days //FIXME: change to 7 days
const issueLabels = new Map([
  ["pending:reproducer", {
    closeLabel: "closed:unreproducible",
    message: "While we asked for a reproducer, none was provided. If you provide a valid reproducer, we will consider this issue again.\nIn the meantime, closing as unreproducible."
  }],
  ["pending:feedback", {
    closeLabel: "closed:missing-feedback",
    message: "While we asked for feedback, none was provided. If you provide the requested feedback, we will consider this issue again.\nIn the meantime, closing as missing feedback."
  }]
]);

const pullsCutoff = new Date(new Date().getDate() - 2); //FIXME: change to 14 days
const pullsLabels = new Map([
  ["pending:dco", {
    closeLabel: "closed:missing-dco",
    message: "While we asked to sign your commits, it has not been done. If you sign your commits, we will consider this pull request again.\nIn the meantime, closing as missing DCO (see the [Developer Certificate of Origin](https://probot.github.io/apps/dco/) GitHub app)."
  }],
  ["pending:feedback", {
    closeLabel: "closed:missing-feedback",
    message: "While we asked for changes to this PR, we received no reaction. If you provide the requested changes, we will consider this pull request again.\nIn the meantime, closing as missing PR feedback."
  }]
]);

const issuesQuery = `query($owner:String!, $name:String!, $labels: [String!]) {
    repository(owner:$owner, name:$name){
      issues(last:100, labels: $labels){
        nodes {
          id, number, updatedAt
          labels(first:100) {
            nodes { id, name }
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
          labels(first:100) {
            nodes { id, name }
          }
        }
      }
    }
}`;

const closeIssueMutation = `mutation ($itemId: ID!, $body: String!, $labelIds: [ID!]!) {
  addComment(input: {subjectId: $itemId, body: $body}) {
    clientMutationId
  }
  closeIssue(input: {issueId: $itemId, stateReason: NOT_PLANNED}) {
    clientMutationId
  }
  removeLabelsFromLabelable(input: {labelableId: $itemId, labelIds: $labelIds}){
    clientMutationId
  }
}`;

const closePullMutation = `mutation ($itemId: ID!, $body: String!, $labelIds: [ID!]!) {
  addComment(input: {subjectId: $itemId, body: $body}) {
    clientMutationId
  }
  closePullRequest(input: {pullRequestId: $itemId}) {
    clientMutationId
  }
  removeLabelsFromLabelable(input: {labelableId: $itemId, labelIds: $labelIds}){
    clientMutationId
  }
}`;

function queryParams(context, feedbackLabels){
    return {owner: context.repo.owner, name: context.repo.repo, labels: Array.from(feedbackLabels.keys())}
}

async function maybeClose(item, cutoff, feedbackLabels, closeMutation) {
    if (new Date(item.updatedAt) < cutoff) {
        const mainLabel = item.labels.find(label => feedbackLabels.has(label.name));

        await github.graphql(closeMutation, {
            item: item.id,
            body: feedbackLabels.get(mainLabel.name).message,
            labelIds: item.labels.filter(label => feedbackLabels.has(label.name) || labelsToRemoveOnClose.has(label.name)).map(label => label.id)
        });

        console.log(`Closed ${item.number} because it was last updated on ${item.updatedAt} and had the label ${mainLabel.name}.`);
    }
}

module.exports = async ({github, context}) => {
    const issuesResult = await github.graphql(issuesQuery, queryParams(context, issueLabels));
    issuesResult.repository.issues.nodes.forEach(issue => maybeClose(issue, issuesCutoff, issueLabels, closeIssueMutation));

    const pullsResult = await github.graphql(pullsQuery, queryParams(context, pullsLabels));
    pullsResult.repository.pullRequests.nodes.forEach(pullRequest => maybeClose(pullRequest, pullsCutoff, pullsLabels, closePullRequestMutation));
}