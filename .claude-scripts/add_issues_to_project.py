#!/usr/bin/env python3
"""Add all repo issues (open + closed) to a GitHub Projects v2 board.

Requires PAT with `project` scope.
"""
import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except AttributeError:
    pass

TOKEN = Path.home().joinpath('.github_pat').read_text(encoding='utf-8').strip()
GRAPHQL = 'https://api.github.com/graphql'
OWNER = 'www161616'
REPO = 'new_erp'
PROJECT_ID = 'PVT_kwHOB2mPBc4BVRWm'  # new_erp 開發看板


def gql(query, variables=None):
    body = json.dumps({'query': query, 'variables': variables or {}}).encode()
    req = urllib.request.Request(
        GRAPHQL, method='POST', data=body,
        headers={
            'Authorization': f'Bearer {TOKEN}',
            'Content-Type': 'application/json',
            'User-Agent': 'new-erp-issue-bot',
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {'errors': [{'message': f'HTTP {e.code}', 'detail': e.read().decode(errors='replace')}]}


ISSUES_QUERY = """
query($cursor: String) {
  repository(owner: "%s", name: "%s") {
    issues(first: 100, after: $cursor, states: [OPEN, CLOSED],
           orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes { id number title state }
    }
  }
}
""" % (OWNER, REPO)

ADD_ITEM = """
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item { id }
  }
}
"""


def fetch_all_issues():
    issues = []
    cursor = None
    while True:
        result = gql(ISSUES_QUERY, {'cursor': cursor})
        if 'errors' in result:
            print('FETCH ERROR:', result['errors'])
            return issues
        data = result['data']['repository']['issues']
        issues.extend(data['nodes'])
        if not data['pageInfo']['hasNextPage']:
            break
        cursor = data['pageInfo']['endCursor']
    return issues


def main():
    print(f'Target: {OWNER}/{REPO} → Project {PROJECT_ID}')
    print()

    print('=== Fetching all issues ===')
    issues = fetch_all_issues()
    print(f'  Total: {len(issues)} issues ({sum(1 for i in issues if i["state"]=="OPEN")} open, {sum(1 for i in issues if i["state"]=="CLOSED")} closed)')
    print()

    print('=== Adding to Project ===')
    added = 0
    failed = 0
    for issue in issues:
        result = gql(ADD_ITEM, {
            'projectId': PROJECT_ID,
            'contentId': issue['id'],
        })
        if 'errors' in result:
            failed += 1
            print(f'  ✗ FAIL #{issue["number"]}: {issue["title"][:60]}')
            print(f'       {result["errors"][0].get("message", "")}')
        else:
            added += 1
            state_icon = '●' if issue['state'] == 'OPEN' else '✓'
            print(f'  {state_icon} added #{issue["number"]:3d}: {issue["title"][:65]}')
        time.sleep(0.15)  # gentle rate-limit

    print()
    print(f'=== DONE: {added} added, {failed} failed ===')
    print(f'View: https://github.com/users/{OWNER}/projects/1')


if __name__ == '__main__':
    main()
