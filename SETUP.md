# SETUP

Instructions for an agent that sets up dsh-superagent with its operator. If you are a person, ask your coding agent to read this file and follow it.

## How to run the setup

The setup follows [docs/000-philosophy.md](docs/000-philosophy.md): it takes as little of the operator's attention as possible.

- **Before the first question,** read only this file and `docs/000-philosophy.md`, and run the probe below once. Read nothing else until every answer is collected.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe already answers.
- **Keep each message under 300 words,** unless the operator asks for more. Give each question a recommended answer the operator can accept with one word, and one sentence on why it matters.
- **Do not execute while asking.** Collect every answer, then send one message with the full plan, and execute only after the operator confirms it.
- **Never ask for a secret in the chat.** Steps that need the operator's hands, such as creating an account, signing a CLI in or entering an app secret, go into one message with the exact commands to run in their own terminal.
- **Teach the philosophy through the questions,** one sentence at a time, not as a lecture.

## 1. Probe

Run from this checkout, once, and keep the result to yourself:

```sh
node -v; pnpm -v; git --version; tmux -V; python3 --version; gh --version | head -1; glab --version | head -1; dsh --version
gh api user --jq .login
command -v lark-cli
grep -l -E 'id: dsh-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **Prerequisites:** Node.js 22.19+ or 24+, pnpm, git 2.32+, tmux, Python 3.8+, and DSH within the `engines.dsh` range of `package.json`, and the CLI of each Source chosen in question 1: GitHub CLI 2.48+ for GitHub, `glab` for GitLab, `lark-cli` for Feishu. DingTalk needs none of its own: `dingtalk-bot` is part of this checkout, built by `pnpm build`. A missing one becomes an item of the plan, not a question. DSH also needs a model provider; if the operator has never run DSH with a model, configuring one is an operator step.
- **Operator login:** the `gh api user` result is the operator's own GitHub login, used as the recommendation in question 5. Nothing probes the operator's GitLab username: question 5 asks for it.
- **Existing profile:** a profile with a `dsh-superagent` entry is an earlier setup: ask whether to continue it, keep its configuration, and read Upgrade in `docs/006-deployment.md`.

## 2. Questions

Ask in this order, one per message, following the flow of work in [docs/001-domain.md](docs/001-domain.md): first where Triggers come from, then who may ask for work there, then what the Executor does with a Ticket. Recommendations are in brackets.

**Sources: where requests come from.**

1. **Sources.** Which code host does the agent work on, GitHub or a self-hosted GitLab (never both: one installation works on one repository), and should it also take requests from Feishu or DingTalk chats? Chats alone work too, without a code host; see Choose the Sources in `docs/006-deployment.md`. [GitHub only, unless the team works on a self-hosted GitLab or in a chat.]
2. **Repository.** Which repository should the agent work on, as `owner/name` on github.com or as `namespace/project` on the GitLab instance? Skip it with chats alone.
3. **Agent account.** Which user account on that code host will the agent act as? [A dedicated account, never the operator's own: everything the agent writes appears under this name.] It may not exist yet; creating it is an operator step. Skip it with chats alone.
4. With Feishu or DingTalk: **which chats,** by name? The agent looks up Feishu chat ids after the bot is configured. DingTalk offers no chat list: a chat's id shows in the panel once someone has mentioned the robot there.

**Policy: who may ask for work.**

5. **On the code host.** Which GitHub logins or GitLab usernames may ask the agent for work? [Only `<operator login>`: the agent acts only for people on this list, and a short list keeps the team's noise low while the operator learns how the agent behaves.]
6. With Feishu or DingTalk: **who may ask in chat?** [Feishu: everyone in the first chat, kept in sync with its members. DingTalk: only the operator, because a DingTalk list cannot be synced from a chat and is typed in by staffId.]

**Execution: what the agent does with a Ticket.**

7. **Checkout.** Which local clone of the repository should each Ticket check out from? [A new clone under `~/src/<name>`.]
8. **Commit identity.** Who should the agent's commits name as author? [The agent account, so its work is visibly its own.] Another identity, such as the operator's, goes into the Delivery requirements prompt section.
9. **Auto-merge.** Only on GitHub: should the agent enable auto-merge on its own pull requests once they are ready and approved? [No: people merge until the agent's pull requests have been right for a while.] The agent never enables it as the agent account, so with yes it needs the GitHub CLI of another account that may merge: ask the operator to sign one in among the operator steps, and name it in Delivery requirements. With no, and always on GitLab, where people merge, remove the auto-merge paragraph from Delivery requirements.

Do not ask about values with a good default; list them in the plan instead:

- profile `superagent`, a copy of DSH's Web profile kept apart from the profile the operator works in, so it restarts without closing their Sessions; port `3082`; state directory `<home>/.dsh/state/superagent` as an absolute path;
- an hourly check from the operator's own profile, which repairs dsh-superagent when it is not running;
- branch prefix `agent/`;
- accept mode `observe`, which records proactive work without doing it, and the default rules and prompt sections;
- with Feishu: the bot reads only mentions, and direct messages are on;
- with GitLab: a poll every 60 seconds, and nothing received beyond what mentions the agent;
- with DingTalk: direct messages are on, and chats other than the listed ones are not received.

## 3. Plan

Send one message, under 300 words: what will be installed, the accounts and CLIs, the settings to save, the operator steps, and the defaults. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** Read the Accounts section of `docs/006-deployment.md`, write the CLI wrappers yourself, then send one message with what only the operator can do: create the agent account and, with auto-merge, sign a CLI in as the account that enables it, accept the repository invitation as the agent account (on GitLab, add the account to the project as Developer or higher, and create its access token with the `api` scope), run `auth login` for each `gh` and `glab` wrapper, for Feishu create and publish the bot app and run the `config init` command with its secret, and for DingTalk create the enterprise internal app with a robot in Stream mode, run `dingtalk-bot config init` with its client secret, and add the robot to each chat. Wait until the operator says it is done, then check each login with `<gh wrapper> api user --jq .login`, `<glab wrapper> api user` (it prints the account's `username`) and `<dingtalk-bot wrapper> auth status`.
2. **Install and start.** Follow the Install, Machine configuration, and Start and stop sections of `docs/006-deployment.md`. Skip the `git clone` of this repository: you are in its checkout. Clone the repository of question 2 if question 7 asked for a new clone. With an existing profile, skip the `dsh superagent --from-default-profile` command, which would replace the profile and delete its `cordis.patch.yml`, and edit that file instead of replacing it.
3. **Settings.** Save them through the Management API of `docs/006-deployment.md`, in this order: the Source of the code host (`github` or `gitlab`), the `feishu` and `dingtalk` Sources if used, the `policy` block with the allowed lists, and the `executor` block with a prepare command from the answer to question 7. Look up chat ids before you save them: for Feishu with the bot's CLI; for DingTalk, which reads no history, save the Source with only the bot's CLI, ask the operator to mention the robot once in each chat, read the chat ids from the `labels` of the `dingtalk` Source in `GET settings` and the operator's staffId from the `actor` of their message, which `GET sources` lists as filtered while no chat is listed, then save the Source again with its chats, before the `policy` block. Then save the prompts with the commit identity of question 8 and the auto-merge answer of question 9 in Delivery requirements. A save that returns `restarting: true` restarts dsh-superagent: wait until `scripts/dsh-superagent status` no longer exits 1 before the next request, and read the revisions again from `GET settings`.
4. **Failures.** A refused save names the setup problem in its response body. Find it in the Troubleshooting table of `docs/006-deployment.md`, fix it, and continue. Ask the operator only for what you cannot fix yourself.

## 5. Verify and hand over

`scripts/dsh-superagent status` exits 0 with no setup problem. If you run in the operator's own DSH profile, create the hourly check of the Hourly check section of `docs/006-deployment.md` with your schedule tool; otherwise give the operator its prompt to schedule there. Then send one message, under 300 words:

- The panel URL, and that the **Superagent** entry in the sidebar is where to look.
- How to try it: from an account on the allowed list, comment `@<agent login> <request>` on an issue in the repository (on GitLab, an Issue or merge request of the project), or mention the robot in a listed chat. A Ticket appears on the overview within about a minute.
- Three rules for the operator, from the Responsibility section of `docs/000-philosophy.md`: start narrow, tune for less noise, own what the agent says.
- Where to read more: the numbered documents in `docs/`, in order.
