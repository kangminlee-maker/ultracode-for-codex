# `code-review` 증거 게이트: 사실 확인과 운용 매뉴얼

- 대상: 작업 브랜치 `docs/evidence-gate-verification` @ `249e828` (PR #23). `package.json`은 아직 `0.6.1`이지만 **동작은 0.6.1 설치본과 다릅니다** — 아래 Part 2가 이 브랜치의 동작이고, 0.6.1 설치본은 `git status`가 만든 `file:` ref의 개수로만 게이트를 판정합니다.
- 확인일: 2026-07-27
- 확인 방법: 소스 독해 + `npm run build` 후 실제 런타임 15케이스 실행 (부록 B가 그 스크립트 원본이며, Part 3의 숫자는 그 출력)
- 이 문서의 독자: ultracode-for-codex를 호출하거나, 그 동작을 사용자에게 설명하는 LLM

> **인용 규칙:** 이 문서는 줄 번호로 코드를 가리키지 않습니다. 이전 판이 그렇게 썼다가 14개 인용이 한 번의 리팩터로 전부 어긋났습니다. 부록 A는 함수·상수 **이름**으로 가리키므로 `grep`으로 항상 찾을 수 있습니다.

---

## Part 1. 검증 대상 주장

> "ultracode는 git status + diff에서 증거 허용목록을 만들어 '방금 바뀐 줄에서 무엇이 깨지는가'를 묻고, git 리포지토리 + 미커밋 변경이 없으면 아예 실행되지 않습니다."

| 주장 조각 | 판정 | 근거 |
| --- | --- | --- |
| git status + diff에서 증거 허용목록을 만든다 | **정확** | `allowedEvidenceRefs` = git status의 `file:` + unstaged/staged/committed diff의 `diff:`/`hunk:` (`buildChangeEvidenceContext`, `diffEvidenceRefs`) |
| 허용목록 밖 인용을 막는다 ("방금 바뀐 줄" 강제) | **조건부 정확** | 경로가 증거에 **없으면** 페일클로즈. 단 ref 문법 실수(뒤에 붙은 줄번호, 잘못된 kind)는 정규화로 되살리고, `--ref-policy lenient`에서는 그 후보 하나만 드롭하고 결과에 `degraded`로 남깁니다 (4.6-(5)) |
| 미커밋 변경이 없으면 에이전트를 띄우지 않는다 | **정확하지만 이유가 다름** | 게이트는 "변경이 있는가"가 아니라 "**리뷰어가 그 변경을 볼 수 있는가**"를 봅니다 (`changeEvidenceGate`). 실측 백엔드 호출 0회 |
| **"git 리포지토리가 없으면"이 전제조건이다** | **부정확** | git repo 검사가 존재하지 않음. 비-git은 "변경 ref 0개"로 걸리는 *부수 결과* |
| **"ultracode가" 실행되지 않는다** | **부정확 (범위 과장)** | 게이트는 빌트인 `code-review`에만 적용. `task`/`batch`/커스텀은 비-git·클린 트리에서도 정상 실행 |
| (누락) 커밋된 변경만 리뷰하는 것도 막힌다 | **이 브랜치에서 해소** | 유효한 `diffBaseRef`만으로 클린 트리에서도 게이트가 열립니다 (케이스 F) |
| (누락) 미커밋 변경이 있어도 막히는 경우가 있다 | **원문에 없는 큰 함정** | 확장자·디렉터리 허용목록 밖(4.6-(1),(2)), 그리고 **예산을 넘겨 읽히지 않는 변경**(4.6-(4)) |

---

## Part 2. 실제 메커니즘

게이트는 **런타임**에 있습니다. 빌트인 스크립트는 그 판정을 읽어서 실패시키는 소비자일 뿐입니다.

```ts
// changeEvidenceGate — 판정의 authority
const readable = evidence.filePaths.filter((path) => {
  const key = workspacePathKey(path);
  return includedPaths.has(key) || hunkPaths.has(key);   // 내용 블록이 실렸거나, diff hunk가 있거나
});
if (readable.length > 0) return { open: true, reason: '' };
```

```js
// code-review 스크립트 본문 — 소비자
if (firstLineValue(context, "evidenceGate: ") === "closed") {
  fail(firstLineValue(context, "evidenceGateReason: "));
}
```

핵심은 **판정 기준이 "ref가 존재하는가"가 아니라 "리뷰어가 실제로 볼 수 있는가"**라는 점입니다. 경로가 인정되려면 둘 중 하나여야 합니다.

1. `### Included Files`에 **내용 블록**이 실렸다, 또는
2. diff에서 **hunk**를 만들었다 (`hunk:<kind>:<path>:<n>`).

둘 다 아니면 리뷰어는 경로 이름만 받고 볼 것이 없으므로, 게이트는 닫힙니다. 이 기준은 파일 선택(프롬프트 예산 배분) **이후에** 평가되고, 그래서 증거 경로가 예산 경쟁에서 먼저 선택됩니다 — 그중에서도 hunk가 없는 경로(미추적 파일은 patch가 없습니다)가 우선입니다.

닫힌 게이트의 사유 문자열은 **두 종류**이고, 처방이 서로 다릅니다.

| 접두어 | 의미 | 처방 |
| --- | --- | --- |
| `no reviewable change evidence in the working tree: …` | 증거가 될 경로가 애초에 없었다 (클린 트리, 비-git, 확장자/디렉터리 제외) | 허용되는 변경을 만들거나 `diffBaseRef`를 주기 |
| `no readable change evidence in the working tree: N changed path(s) were admitted but none produced readable evidence …` | 경로는 인정됐지만 **읽히지 않았다** (내용 블록이 예산에 못 들어가고 hunk도 없음) | 변경을 줄이거나 예산을 올리거나 `git add`로 diff를 만들기. 바이너리면 증거로 리뷰 불가 |

첫 번째 사유는 어떤 규칙이 어떤 경로를 드롭했는지 이름을 댑니다(`changeEvidenceGateReason`). 런타임 자기 상태 파일(`.ultracode-for-codex/`)과 안전하지 않은 이름은 호출자의 변경이 아니므로 개수만 세고 이름을 노출하지 않습니다.

git 리포지토리 여부는 어디서도 검사하지 않습니다.

| 상황 | 런타임 동작 | 위치 (함수명) |
| --- | --- | --- |
| `git rev-parse --show-toplevel` 실패 | throw 없이 `cwd`로 폴백 | `workspaceContextRoot` |
| `git status` 실패 | throw 없이 `unavailable:git-status:<token>` 증거 토큰으로 기록 | `collectWorkspaceGitStatus` |
| 결과 | 변경 경로 0개 → 읽을 증거 0개 → 게이트 닫힘 | `changeEvidenceGate` |

**커밋은 필요 없습니다.** 커밋이 0개인 repo에서 미추적 파일만 있어도 통과합니다(케이스 D). "최소 1커밋"을 요구하는 것은 `isolation: "worktree"`뿐입니다.

**같은 판정을 토큰 0으로 미리 볼 수 있습니다.** `run --validate --name code-review`는 런타임의 **같은 빌더**를 호출하므로(재계산이 아닙니다) 사전 확인과 실제 실행이 어긋날 수 없습니다.

---

## Part 3. 검증 증거 (실측)

FakeSubagent 백엔드(첫 호출에서 즉시 예외)로 실제 런타임을 구동해, 게이트가 **에이전트 스폰 이전**에 작동하는지 백엔드 호출 수로 확인했습니다. `gate` 열은 실패 메시지의 접두어입니다.

| # | 조건 | 워크플로 | 백엔드 호출 | gate |
| --- | --- | --- | --- | --- |
| A | git repo 아님 + 미추적 `.ts` | `code-review` | 0 | `reviewable` |
| B | git repo, 깨끗한 트리 | `code-review` | 0 | `reviewable` |
| C | git repo, 미커밋 `.ts` 변경 | `code-review` | **1** | (실행) |
| D | 커밋 0개 repo + 미추적 `.ts` | `code-review` | **1** | (실행) |
| E | git repo 아님 | **`task`** | **1** | (실행) |
| F | 깨끗한 트리 + `diffBaseRef: "HEAD~1"` | `code-review` | **1** | (실행) |
| F2 | 깨끗한 트리 + `diffBaseRef: "HEAD"` | `code-review` | 0 | `reviewable` |
| G | 미커밋 변경이 `src/App.java`뿐 (기본 scope) | `code-review` | 0 | `reviewable` |
| G2 | 같은 트리 + `--evidence-scope all` | `code-review` | **1** | (실행) |
| H | 미커밋 변경이 `Dockerfile`+`Makefile`뿐 | `code-review` | 0 | `reviewable` |
| I | 미커밋 변경이 `dist/bundle.js`뿐 | `code-review` | 0 | `reviewable` |
| J | 미커밋 변경이 `src/app.ts` (대조군) | `code-review` | **1** | (실행) |
| K | `src/App.java` + `notes.md` | `code-review` | **1** | (실행) |
| L | 미추적 `.ts` 하나가 `maxFileBytes`(12,000) 초과 | `code-review` | 0 | **`readable`** |
| M | 미추적 바이너리(`.png`)뿐 + `--evidence-scope all` | `code-review` | 0 | **`readable`** |

케이스 C·D·E·F·G2·J·K는 게이트가 무조건 실패하는 것이 아님을 증명하는 **대조군**입니다(음성 대조가 없으면 A·B의 실패는 아무것도 증명하지 못합니다).

읽어야 할 대비 두 쌍:

- **F vs F2** — `diffBaseRef`는 이제 혼자서도 게이트를 엽니다. F2가 막히는 이유는 `HEAD..HEAD`가 **빈 구간**이기 때문이지, 커밋 구간 리뷰 경로가 없기 때문이 아닙니다. 0.6.1 판 매뉴얼은 `HEAD`를 base로 준 F2만 측정해 "커밋 구간 리뷰는 불가"라고 결론했는데, 그것은 거짓 대조군이었습니다.
- **L vs J** — 둘 다 미추적 `.ts` 하나뿐인데 L만 막힙니다. 차이는 오직 **크기**입니다. 파일이 `maxFileBytes`를 넘으면 내용 블록이 실리지 않고, 미추적 파일은 patch가 없으므로 hunk도 없습니다 → 리뷰어가 볼 것이 없어 게이트가 닫힙니다.

케이스 K의 워킹트리(`src/App.java`, `notes.md`, `Dockerfile`, `dist/bundle.js` 모두 수정)에서 증거 허용목록을 덤프하면 기본 scope에서는 이렇습니다:

```
### Allowed Evidence Refs
file:notes.md
```

즉 **`.java`·`Dockerfile`·`dist/*`는 기본 scope에서 인용 가능한 증거가 되지 못합니다.** 게이트는 `notes.md` 하나로 열리지만 리뷰 대상도 `notes.md`뿐입니다. 다만 "보이지 않는다"는 아닙니다 — 제외 디렉터리 밖의 `.java`·`Dockerfile`은 `### Git Status` 절에 이름이 그대로 나오고, 내용과 인용만 막힙니다(4.6-(3)). `dist/*`는 status에서도 마스킹됩니다.

경로 필터의 경계도 19개 파일을 한 워킹트리에 놓고 허용목록을 덤프해 확인했습니다:

| 포함 | 제외 |
| --- | --- |
| `src/app.ts`, `style.css`, `notes.txt`, `mod.rs` | `src/App.java`, `Makefile`, `Dockerfile`, `schema.sql`, `x.vue` |
| `distribution/a.ts`, `outer/d.ts` (부분 문자열은 무해) | `dist/c.ts`, `src/dist/b.ts`, `out/e.ts`, `nested/build/f.ts`, `coverage/g.json`, `artifacts/h.md` |
| `.github/workflows/ci.yml`, `legacy.JS` (대소문자 무관) | — |

이 트리에서 `--validate`가 보고하는 드롭 목록(실측) — 규칙까지 경로별로 나옵니다:

```
Dockerfile(extension-not-allowed) Makefile(extension-not-allowed) schema.sql(extension-not-allowed)
src/App.java(extension-not-allowed) x.vue(extension-not-allowed)
artifacts/h.md(excluded-dir) coverage/g.json(excluded-dir) dist/c.ts(excluded-dir)
nested/build/f.ts(excluded-dir) out/e.ts(excluded-dir) src/dist/b.ts(excluded-dir)
```

케이스 B·L은 회귀 테스트가 커버합니다(`test/workflow-runtime.test.mjs`에서 `a clean tree without diffBaseRef stays gated`, `the gate refuses to open when an admitted path produced nothing readable`).

---

## Part 4. 운용 매뉴얼

### 4.1 실행 전 체크리스트

**가장 확실한 사전 확인은 런타임에게 직접 묻는 것입니다.** 에이전트도 토큰도 쓰지 않고, 실제 실행과 같은 빌더로 판정합니다.

```bash
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 --validate \
  --name code-review --cwd /path/to/project \
  --args '{"prompt":"리뷰 의도"}'
```

기본 출력은 JSON입니다. `.java`만 바뀐 트리에서의 실측 출력(발췌):

```json
{
  "kind": "ultracode.workflow.validate",
  "status": "valid",
  "workflowName": "code-review",
  "evidence": {
    "gated": true,
    "reason": "no reviewable change evidence in the working tree: git status reported 1 changed path(s), all dropped before becoming evidence — 1 by extension-not-allowed (src/App.java); change a file whose extension is in the evidence allowlist and outside the excluded directories, or pass diffBaseRef to review a committed range, and re-run `--validate` to confirm before spending",
    "allowedFileRefs": 0,
    "allowedEvidenceRefs": [],
    "dropped": [{ "path": "src/App.java", "rule": "extension-not-allowed" }]
  }
}
```

**읽는 순서를 틀리지 마십시오.** 최상위 `status: "valid"`는 *요청 계약*이 유효하다는 뜻이고, 실행 가능 여부는 `evidence.gated`가 답합니다. 위 출력은 "요청은 올바르지만 이대로 실행하면 게이트에 막힌다"는 뜻입니다.

사람이 읽을 형태가 필요하면 `--plain`을 붙입니다 (실측 출력):

```
[validate] code-review (built_in) agents=7 schema=6 keyed=6
[validate] evidence: gated fileRefs=0 evidenceRefs=0
[validate] evidence: no reviewable change evidence in the working tree: git status reported 1 changed path(s), all dropped before becoming evidence — 1 by extension-not-allowed (src/App.java); …
[validate] dropped: src/App.java (extension-not-allowed)
```

`--validate`는 요청 계약(오타난 `--args` 키, 잘못된 `level`, 해석 불가 `diffBaseRef`)까지 함께 검사하므로 완전한 사전 점검입니다.

`--validate`를 못 쓰는 상황이라면 다음 순서로 눈으로 확인하십시오. 단 `git status`는 **필요조건일 뿐 충분조건이 아닙니다** — 케이스 L처럼 변경이 보여도 읽히지 않아 막힐 수 있습니다.

1. **리뷰할 변경이 존재하는가** — `git status --short`가 비어 있지 않거나, 유효한 `diffBaseRef` 구간에 커밋이 있어야 합니다(둘 중 하나로 충분).
2. **그 변경이 허용 확장자인가** — 아니면 `--evidence-scope all`로 확장자 규칙만 완화할 수 있습니다(4.6-(1)).
3. **그 변경이 제외 디렉터리 밖인가** — `dist/`, `build/`, `node_modules/` 등만 바뀐 경우는 어떤 scope에서도 통과하지 못합니다.
4. **파일이 지나치게 크지 않은가** — 미추적 파일이 12,000바이트를 넘으면 `git add`로 스테이징해 diff를 만들어 주십시오(4.6-(4)).
5. **리뷰하려는 파일이 허용목록에 들어오는가** — 게이트 통과와 "내가 원하는 파일이 리뷰된다"는 별개입니다(케이스 K).

```bash
git -C /path/to/project status --short --untracked-files=all
```

### 4.2 표준 호출

```bash
# 0) 최초 1회 준비 확인 (설치·인증·모델 지원 여부)
npm exec --no -- ultracode-for-codex setup || ultracode-for-codex setup

# 1) 리뷰 실행 (백그라운드). --execution 기본값은 settings.json(background)이지만
#    예시가 설정에 의존하지 않도록 명시합니다.
npm exec -- ultracode-for-codex run \
  --accept-llm-guide=v1 \
  --name code-review \
  --execution background \
  --cwd /path/to/project \
  --args '{"prompt":"방금 바꾼 인증 경로의 정합성과 회귀 위험을 리뷰","level":"high"}' \
  --permission allow

# 2) 진행 상황 / 결과
npm exec -- ultracode-for-codex status <jobId> --cwd /path/to/project
npm exec -- ultracode-for-codex logs <jobId> --tail 40 --cwd /path/to/project   # --tail 은 값 필수
npm exec -- ultracode-for-codex result <jobId> --cwd /path/to/project
```

`status <jobId>`가 보고하는 `runId`와 `cwd`는 나중의 resume에 필요한 복구 앵커입니다. 실행 직후 기록해 두십시오.

리뷰 정책 플래그 두 개는 **기본 off**이며, 필요할 때만 붙입니다.

| 플래그 | 기본값 | 켜면 달라지는 것 |
| --- | --- | --- |
| `--evidence-scope <default\|all>` | `default` (`settings.json: workflow.evidenceScope`) | `all`은 **확장자 허용목록만** 완화합니다. 제외 디렉터리·런타임 상태·안전하지 않은 경로는 어떤 scope에서도 인정되지 않습니다 |
| `--ref-policy <strict\|lenient>` | `strict` (`settings.json: workflow.refPolicy`) | `lenient`는 증거에서 경로를 찾을 수 없는 인용 하나만 드롭하고 결과에 `degraded` + `stats.refDrops`를 남깁니다. 후보가 **전부** 드롭되면 그 실행은 여전히 실패합니다(깨끗한 리뷰로 위장할 수 없음). 렌즈 판단과 구조 위반은 모든 정책에서 치명적 |

`--ref-policy`가 기본값이 아니면 실행 시 stderr에 공지가 찍힙니다. 정책은 빌트인 스크립트 본문에 박히므로 두 정책의 스크립트 해시가 다르고, **정책이 다른 실행을 resume하는 것은 거부됩니다**.

### 4.3 `--args` 스펙 (`code-review`)

| 키 | 타입 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `prompt` | string | 내장 기본 프롬프트 | 리뷰 의도. 렌즈 선택에 영향 |
| `level` | `"high"` \| `"xhigh"` \| 생략 | 생략 = `xhigh` | 4.4 참조. 대소문자 무관 |
| `diffBaseRef` | string (커밋-ish) | 없음 | `<base>..HEAD` 커밋 구간을 증거에 추가. **이것만으로 게이트를 열 수 있습니다** |

`diffBaseRef`는 CLI 플래그가 아니라 `--args` JSON 안의 키입니다. `--diff-base` 같은 플래그는 존재하지 않습니다.

**요청 인자는 지출 전에 검증됩니다.** 모르는 키(가까운 키 제안 포함), `prompt`가 문자열이 아닌 경우, 지원하지 않는 `level`, `git rev-parse --verify`로 해석되지 않는 `diffBaseRef`는 에이전트를 띄우기 전에 거부되고, 거부된 값·원인·조치를 함께 반환합니다. 조용히 무시되는 인자는 없습니다.

### 4.4 `level` 프로파일

| | `{"level":"high"}` | `{"level":"xhigh"}` 또는 생략 |
| --- | --- | --- |
| scope effort | `medium` | `xhigh` |
| find/verify effort | `high` | `xhigh` |
| 최대 렌즈 수 | 8 | 10 |
| 렌즈당 후보 상한 | 6 | 8 |
| sweep 단계 | 없음 | 있음 |
| 보고 상한 | 10건 | 15건 |

비용·지연을 줄이려면 `{"level":"high"}`, 정확도를 최대화하려면 생략하십시오.

### 4.5 실패 메시지 해독표

| 메시지 | 원인 | 조치 |
| --- | --- | --- |
| `no reviewable change evidence in the working tree: git status reported no changed or untracked paths; …` | 증거가 될 변경이 없음 (비-git, 클린 트리) | 변경을 만들거나 유효한 `diffBaseRef`를 주기 |
| `no reviewable change evidence …: git status reported N changed path(s), all dropped before becoming evidence — 1 by extension-not-allowed (App.java); …` | 변경은 있으나 규칙에 드롭됨. **어떤 규칙이 어떤 경로를 드롭했는지 메시지가 말합니다** | 확장자 문제면 `--evidence-scope all`, 디렉터리 문제면 다른 경로의 변경 |
| `no readable change evidence in the working tree: N changed path(s) were admitted but none produced readable evidence …` | 경로는 인정됐지만 읽히지 않음 (예산 초과 + hunk 없음, 또는 바이너리) | `git add`로 diff를 만들거나 변경을 줄이거나 예산을 올리기. 바이너리는 증거 리뷰 불가 |
| `… includes unsupported evidence ref file:X: not in allowed evidence refs (N entries) …` | 에이전트가 증거에 없는 **경로**를 인용 | 정상적인 페일클로즈. 문법 실수는 이미 정규화로 흡수되므로, 이 메시지는 경로 자체가 없다는 뜻 |
| `code-review invalid: … rejected value … cause … remediation …` | 요청 계약 위반 (오타 키, 잘못된 `level`, 해석 불가 `diffBaseRef`) | 메시지가 거부된 값과 조치를 그대로 알려줍니다 |
| `worktree isolation requires a git repository with at least one commit` | `isolation: "worktree"` 사용 시에만 발생 | git repo + 최초 커밋. `code-review` 자체와 무관 |
| `setup`이 `loggedIn: false` 보고 | Codex 미인증 | 사용자에게 `!codex login` 요청 |

게이트 실패는 저널에 재사용할 에이전트 결과가 없으므로 `--resume-from-run-id`의 대상이 아닙니다. 워킹트리를 정리하고 새로 실행하는 것이 정답입니다.

### 4.6 자주 걸리는 함정

**(1) 확장자 허용목록 — 가장 자주 걸리지만, 이제 정식 우회로가 있습니다.**

기본 scope에서 증거로 인정되는 확장자는 다음 18개입니다:

```
.cjs .css .go .html .js .json .jsx .md .mjs .py .rs .sh .toml .ts .tsx .txt .yaml .yml
```

비교는 대소문자를 구분하지 않습니다(`legacy.JS`는 통과). 따라서 `.java`, `.kt`, `.swift`, `.rb`, `.php`, `.c`, `.h`, `.cpp`, `.cs`, `.sql`, `.vue`, `.svelte`, `.tf`, `.proto`, `.env`, `Dockerfile`, `Makefile`만 바뀐 변경은 기본 scope에서 막힙니다(케이스 G·H).

**`--evidence-scope all`이 이 규칙만 완화합니다**(케이스 G2). `.java`/`.rb`/`.sql`/`.kt` 저장소도 `code-review`로 리뷰할 수 있습니다. 제외 디렉터리·런타임 상태·안전하지 않은 경로는 완화되지 않습니다.

확장자 없는 파일명은 정확한 파일명 예외 8개(`AGENTS.md`, `CONTRACT.md`, `IMPLEMENTATION_MAP.html`, `README.md`, `SKILL.md`, `ULTRACODE_INSTALL.md`, `package.json`, `tsconfig.json`)를 빼면 제외됩니다. 이 예외는 "확장자가 없어서"가 아니라 **파일명 정확 일치**로 동작합니다.

**(2) 제외 디렉터리 — 경로 세그먼트 단위 정확 일치**

경로를 `/`로 쪼갠 **구성요소 중 하나가 다음 이름과 정확히 일치**하면 제외됩니다. 문자열 부분 일치가 아닙니다.

```
.git  .next  .turbo  .ultracode-for-codex  artifacts  build  coverage  dist  node_modules  out
```

| 경로 | 판정 | 이유 |
| --- | --- | --- |
| `dist/c.ts` | 제외 | `dist` 세그먼트 |
| `src/dist/b.ts` | 제외 | 최상위가 아니어도 세그먼트면 제외 |
| `out/e.ts`, `nested/build/f.ts`, `coverage/g.json` | 제외 | 동일 |
| `distribution/a.ts` | **포함** | `dist`는 부분 문자열일 뿐 |
| `outer/d.ts` | **포함** | `out`은 부분 문자열일 뿐 |
| `.github/workflows/ci.yml` | **포함** | 목록에 없는 점디렉터리는 제외 대상이 아님 |

빌드 산출물만 바뀐 상태에서 리뷰를 걸면 실패합니다(케이스 I).

**(3) 게이트 통과 ≠ 원하는 파일이 리뷰됨 — 게다가 에이전트는 그 파일을 봅니다**

허용 확장자 파일 하나만 있어도 게이트는 열립니다. 그러나 허용목록 밖 파일은 증거에 없으므로 리뷰되지 않고, 그 파일을 인용한 발견은 페일클로즈로 거부됩니다(케이스 K).

여기에 비대칭이 하나 더 있습니다. 프롬프트의 `### Git Status` 섹션은 **디렉터리 제외만 적용하고 확장자 필터는 적용하지 않습니다**(`shouldExposeWorkspaceStatusPath`). 실측 출력:

```
?? Dockerfile          ← 상태에는 보이지만 증거 ref는 없음
?? src/App.java        ← 상태에는 보이지만 증거 ref는 없음
?? schema.sql          ← 상태에는 보이지만 증거 ref는 없음
?? src/app.ts          ← 유일하게 인용 가능
?? <excluded path omitted>   ← dist/ build/ coverage/ 등은 이렇게 마스킹됨
```

즉 에이전트는 `src/App.java`가 바뀐 사실을 보면서도 그것을 인용할 수 없습니다. 리뷰 범위는 `### Git Status`가 아니라 **`### Allowed Evidence Refs`로 판단하십시오.** 프롬프트에는 `#### Dropped From Evidence` 절도 있어, 어떤 경로가 어떤 규칙으로 빠졌는지 리뷰어가 직접 볼 수 있습니다.

**(4) 인정됐지만 읽히지 않는 변경 — 이 브랜치에서 새로 드러나는 함정**

증거로 인정된 경로라도 리뷰어가 볼 수 없으면 게이트는 닫힙니다(케이스 L·M). 조건이 겹칠 때 발생합니다.

- **미추적 파일 + `maxFileBytes`(기본 12,000) 초과** — 내용 블록이 실리지 않고, 미추적이라 patch도 없음. → `git add <path>`로 스테이징하면 diff가 생겨 읽힙니다.
- **바이너리 파일** (`--evidence-scope all`로 확장자를 완화한 경우) — hunk도 내용 블록도 만들 수 없음. → 증거 기반 리뷰의 대상이 아닙니다.

예산 기본값: `maxFiles` 24, `maxFileBytes` 12,000, `maxBytes` 80,000. 증거 경로는 다른 후보보다 먼저 선택되고, 그중 hunk가 없는 경로가 다시 우선이므로, 파일이 많아도 증거가 예산 경쟁에서 밀려 사라지지는 않습니다.

**(5) `--ref-policy`가 실패의 의미를 바꿉니다**

`strict`(기본)에서는 증거에 없는 ref를 인용한 후보가 실행 전체를 실패시킵니다. `lenient`에서는 그 후보만 드롭되고 결과에 `degraded`가 붙습니다. 따라서 **`lenient` 결과를 "발견 없음 = 깨끗함"으로 읽으면 안 됩니다** — `stats.refDrops`와 `degraded`를 먼저 보십시오. 후보가 전부 드롭되면 실행은 실패하므로, 드롭된 리뷰가 깨끗한 리뷰로 위장하는 경로는 없습니다.

### 4.7 `code-review`가 막힐 때의 대안

| 상황 | 대안 |
| --- | --- |
| 허용목록 밖 언어(`.java` 등) 코드를 리뷰해야 함 | **`--evidence-scope all`** (1순위). 그래도 안 되면 빌트인 `task` 또는 커스텀 워크플로 — 단 리뷰 하네스(렌즈 선택·후보 검증·프로버넌스)는 제공되지 않습니다 |
| 이미 커밋된 변경(PR 브랜치 등)을 리뷰해야 함 | `--args '{"prompt":"…","diffBaseRef":"<base>"}'`. 클린 트리에서도 동작합니다(케이스 F). `HEAD`를 base로 주면 빈 구간이니 실제 base 커밋을 주십시오 |
| 큰 미추적 파일이 막힘 | `git add <path>`로 스테이징 (diff가 생겨 읽힘) |
| 리뷰가 아니라 분석·계획 | `--name task` (읽기 전용 분석 + 구현 가이드) |

### 4.8 리뷰 이후 금지사항

`code-review`는 리뷰 전용입니다. 발견을 심각도 순으로 제시하고 **멈추십시오.** 수정이 자명해 보여도 파일을 편집하거나 구현 단계를 이어서 시작하지 마십시오. 어떤 발견을 처리할지 사용자에게 묻고, 그것은 별도의 구현 요청으로 다루십시오.

---

## Part 5. 권장 표현

원문을 다음으로 대체하십시오.

> ultracode-for-codex의 빌트인 `code-review`는 `git status` + diff에서 증거 허용목록을 만들어 "방금 바뀐 줄에서 무엇이 깨지는가"를 묻습니다. **리뷰어가 실제로 읽을 수 있는 변경 증거가 없으면 에이전트를 하나도 띄우지 않고 실패합니다** — 비-git 디렉터리, 깨끗한 트리, 변경 파일이 전부 허용 확장자·디렉터리 밖인 경우, 그리고 인정은 됐지만 예산을 넘겨 읽히지 않는 경우가 모두 여기에 해당합니다. 커밋된 구간만 리뷰하려면 `diffBaseRef`를 주면 되고, 다른 언어를 리뷰하려면 `--evidence-scope all`이 확장자 규칙만 완화합니다. 이 게이트는 `code-review` 한정이며 `task`·`batch`·커스텀 워크플로에는 적용되지 않습니다.

한 문장으로 줄여야 한다면:

> `code-review`는 리뷰어가 읽을 수 있는 변경 증거(워킹트리 변경, 또는 `diffBaseRef` 커밋 구간)를 요구하고, 그런 증거가 없으면 에이전트 실행 전에 실패합니다.

"git 리포지토리가 없으면"이라는 전제조건 표현은 쓰지 마십시오. 구현에 그런 검사가 없고, 실패 원인을 사용자가 잘못 진단하게 만듭니다.

---

## 부록 A. 코드 참조 (이름 기준)

모두 `src/runtime/workflow-runtime.ts`이며, 표시된 것만 예외입니다. 줄 번호를 쓰지 않는 이유는 문서 상단의 인용 규칙에 있습니다.

| 대상 | 심볼 |
| --- | --- |
| 증거 게이트 판정 (authority) | `changeEvidenceGate` |
| 게이트 사유 문자열 | `changeEvidenceGateReason` (드롭 규칙 샘플은 `describeDroppedPathSample`) |
| 게이트 판정을 프롬프트에 실음 | `buildWorkspaceContext` (`evidenceGate:` / `evidenceGateReason:` 헤더 줄) |
| 스크립트 측 소비 | `DEFAULT_BUILTIN_WORKFLOWS`의 `code-review` 본문 — `firstLineValue(context, "evidenceGate: ")` |
| 증거 컨텍스트·ref 조립 | `buildChangeEvidenceContext` |
| diff/hunk ref 생성 (+ hunk 보유 경로) | `diffEvidenceRefs` |
| 경로 admission 단일 authority | `workspaceContextPathVerdict`, `evidencePathAllowed`, `evidenceScopeForgives` |
| Git Status 표시용 필터 (확장자 미적용) | `shouldExposeWorkspaceStatusPath` |
| 세그먼트 정확 일치 / 경로 정규화 | `workspacePathExcludedBySet`, `workspacePathKey` |
| 제외 디렉터리 / 허용 확장자 / 우선 파일명 | `WORKSPACE_CONTEXT_EXCLUDED_DIRS`, `WORKSPACE_CONTEXT_ALLOWED_EXTENSIONS`, `WORKSPACE_CONTEXT_PRIORITY_FILES` |
| 예산 기본값 | `DEFAULT_WORKSPACE_CONTEXT_MAX_FILES` / `_MAX_FILE_BYTES` / `_MAX_BYTES` |
| 요청 계약 (키·enum·커밋 ref 검증) | `BUILTIN_REQUEST_CONTRACTS`, `validateBuiltinRequestArgs`, `CODE_REVIEW_LEVELS` |
| `--validate` 증거 프리뷰 | `validateWorkflowInput` → `previewChangeEvidence`; CLI 출력은 `src/cli.ts` |
| 워크스페이스 루트 폴백 (비-git) | `workspaceContextRoot` |
| `git status` 실패 처리 | `collectWorkspaceGitStatus` |
| `level` 프로파일 / caps | `DEFAULT_BUILTIN_WORKFLOWS`의 `code-review` 본문 `caps` |
| worktree 격리의 git 요구사항 | `createAgentWorktree` (`worktree isolation requires a git repository with at least one commit`) |
| 회귀 테스트 | `test/workflow-runtime.test.mjs` — `a clean tree without diffBaseRef stays gated`, `the gate refuses to open when an admitted path produced nothing readable`, `an evidence path is read before ordinary budget candidates` |

## 부록 B. 재현 스크립트

`npm run build` 후 실행합니다. 실제 서브에이전트를 부르지 않으므로 토큰 비용이 없습니다. Part 3의 표가 이 스크립트의 출력입니다.

```js
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const x = promisify(execFile);
const { WorkflowTaskRegistry } = await import('<repo>/dist/runtime/workflow-runtime.js');

async function probe(label, { git = true, commit = true, files = [], commitFirst = [], args = {}, name = 'code-review', scope = 'default', binary = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'probe-'));
  const g = (...a) => x('git', a, { cwd: root });
  if (git) {
    await g('init'); await g('config', 'user.email', 'p@e.invalid'); await g('config', 'user.name', 'P');
    if (commit) { await writeFile(join(root, 'README.md'), '# probe\n'); await g('add', '.'); await g('commit', '-m', 'init'); }
  }
  for (const f of commitFirst) {
    await mkdir(dirname(join(root, f)), { recursive: true });
    await writeFile(join(root, f), 'committed\n');
  }
  if (commitFirst.length) { await g('add', '-A'); await g('commit', '-m', 'range'); }
  for (const f of files) {
    await mkdir(dirname(join(root, f)), { recursive: true });
    // .big.ts 는 maxFileBytes(12,000)를 넘겨 내용 블록이 실리지 않게 만드는 픽스처입니다.
    await writeFile(join(root, f), f.endsWith('.big.ts') ? `export const pad = "${'x'.repeat(20000)}";\n` : 'changed\n');
  }
  if (binary) await writeFile(join(root, binary), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0x00]));
  const backend = { name: 'p', model: 'p', calls: 0, async generate() { this.calls += 1; throw new Error('STOP'); }, async close() {} };
  const runtime = new WorkflowTaskRegistry({ backend, cwd: root, stateDir: join(root, '.ultracode-for-codex'), requestTimeoutMs: 20000, evidenceScope: scope });
  const launch = await runtime.launch({ name, args: { prompt: 'Review.', ...args } });
  for await (const e of runtime.streamEvents(launch.taskId)) void e;
  const s = runtime.get(launch.taskId);
  const err = s.error ?? '';
  // 닫힌 게이트의 접두어는 두 종류입니다. 하나만 보면 예산으로 닫힌 게이트를 놓칩니다.
  const kind = /no reviewable change evidence/.test(err) ? 'reviewable'
    : /no readable change evidence/.test(err) ? 'readable'
    : err ? 'other' : '(ran)';
  console.log(`${label} | calls=${backend.calls} | gate=${kind}`);
  await runtime.close();
  await rm(root, { recursive: true, force: true });
}

await probe('A non-git + untracked .ts   ', { git: false, files: ['src/app.ts'] });
await probe('B clean tree                ', {});
await probe('C uncommitted .ts           ', { files: ['src/app.ts'] });
await probe('D zero-commit + untracked   ', { commit: false, files: ['src/app.ts'] });
await probe('E non-git + task            ', { git: false, files: ['src/app.ts'], name: 'task' });
await probe('F clean + diffBaseRef HEAD~1', { commitFirst: ['src/ranged.ts'], args: { diffBaseRef: 'HEAD~1' } });
await probe('F2 clean + diffBaseRef HEAD ', { commitFirst: ['src/ranged.ts'], args: { diffBaseRef: 'HEAD' } });
await probe('G .java only (default)      ', { files: ['src/App.java'] });
await probe('G2 .java only (scope=all)   ', { files: ['src/App.java'], scope: 'all' });
await probe('H Dockerfile+Makefile only  ', { files: ['Dockerfile', 'Makefile'] });
await probe('I dist/bundle.js only       ', { files: ['dist/bundle.js'] });
await probe('J src/app.ts (control)      ', { files: ['src/app.ts'] });
await probe('K .java + notes.md          ', { files: ['src/App.java', 'notes.md'] });
await probe('L untracked .ts over budget ', { files: ['src/huge.big.ts'] });
await probe('M binary only (scope=all)   ', { binary: 'logo.png', scope: 'all' });
```

비-git 케이스는 `git: false`로, 커밋 0개 케이스는 `commit: false`로 재현됩니다.
