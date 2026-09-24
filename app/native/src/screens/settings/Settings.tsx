import { GroupHead, Screen } from '@/components/layout/Screen'
import { ErrorNote, Loading } from '@/components/state'
import { useSaveSettings, useSettings } from '@/modules/api/settings.hooks'
import { PolicyPicker } from '@/screens/repos/repos.components'
import { Field, NumberField, Toggle } from './settings.components'

/**
 * What the factory does, and how much of it without a person.
 *
 * Each control saves on its own rather than behind one button, because the
 * route takes a partial and a save button would invite restating every field
 * to change one of them.
 */
export function Settings() {
  const settings = useSettings()
  const save = useSaveSettings()

  if (settings.isPending) {
    return (
      <Screen title="Settings">
        <Loading />
      </Screen>
    )
  }

  if (settings.isError) {
    return (
      <Screen title="Settings">
        <ErrorNote
          message={settings.error.message}
          onRetry={() => settings.refetch()}
        />
      </Screen>
    )
  }

  const current = settings.data.settings

  return (
    <Screen title="Settings" sub="Saved as you change them.">
      <GroupHead label="The factory" />
      <section className="mb-5 rounded-xl border border-border bg-card px-4">
        <Field
          label="Default policy"
          detail="What a repository does when it sets none of its own."
        >
          <PolicyPicker
            value={current.defaultPolicy}
            pending={save.isPending}
            onChange={(defaultPolicy) => save.mutate({ defaultPolicy })}
          />
        </Field>
        <Field label="Poll every" detail="Seconds between looks at GitHub.">
          <NumberField
            value={current.pollSeconds}
            min={10}
            onCommit={(pollSeconds) => save.mutate({ pollSeconds })}
          />
        </Field>
        <Field
          label="Revisions"
          detail="How many times the reviewer may send work back before a run gives up."
        >
          <NumberField
            value={current.maxRevisions}
            min={0}
            onCommit={(maxRevisions) => save.mutate({ maxRevisions })}
          />
        </Field>
      </section>

      <GroupHead label="Trust" />
      <section className="mb-5 rounded-xl border border-border bg-card px-4">
        <Field
          label="Trusted authors only"
          detail="An issue body is instructions to an agent with shell access. Off admits anyone."
        >
          <Toggle
            label="trusted authors only"
            checked={current.trustedAuthorsOnly}
            onChange={(trustedAuthorsOnly) =>
              save.mutate({ trustedAuthorsOnly })
            }
          />
        </Field>
        <Field
          label="Ask before the agent acts"
          detail="Pauses a turn when an agent wants a permission its station does not cover. The question expires with the turn."
        >
          <Toggle
            label="ask on permission"
            checked={current.askOnPermission}
            onChange={(askOnPermission) => save.mutate({ askOnPermission })}
          />
        </Field>
      </section>

      {save.isError ? (
        <p className="text-[12.5px] text-destructive">{save.error.message}</p>
      ) : null}
    </Screen>
  )
}
