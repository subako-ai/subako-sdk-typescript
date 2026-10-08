# @subako-ai/react-hook-form

[react-hook-form](https://react-hook-form.com) as a `formTool` spec for
`@subako-ai/tools`: the registered names describe the form, `setValue` is the
write, and `getValues` with `formState.errors` is the read back.

Requires **react-hook-form 7.50 or newer** and **Node 22 or newer** for the
build. The package is **ESM only**.

```sh
pnpm add @subako-ai/react-hook-form @subako-ai/tools
```

## `fromReactHookForm`

```tsx
import { useTool } from "@subako-ai/react";
import { fromReactHookForm } from "@subako-ai/react-hook-form";
import { formTool } from "@subako-ai/tools";

const form = useForm({ defaultValues: { email: "", message: "" } });
useTool(client, "fill_contact_form", formTool({ ...fromReactHookForm(form), description: "The contact form." }));
```

`fromReactHookForm(form, { schema? })` answers with `fields` or `schema`,
`apply` and `read`, which is everything `formTool` takes.

It writes with `setValue(name, value, { shouldValidate: true, shouldDirty: true })`
and reads with `getValues()` and `formState.errors`, so the model sees what the
form's own validation made of the fill.

Nested and array errors use dotted paths, such as `meta.subject` and
`signers.0.email`. Root errors are included too, for example `root.server`.

**`apply` waits for the form to catch up.** `formTool` reads the form back as
soon as `apply` resolves, and `setValue` returns before two things have happened:
the validation it asked for, and the update that publishes the result to
`formState`. So `apply` awaits `trigger()` and then a turn of the task queue —
waiting for only the first is enough when a fill clears an error and not when it
raises one. Without both, a fill is read back with the errors of the fill before
it, and a model reading that sees a field it has just corrected still reported as
wrong. `trigger()` validates the whole form, so `read` reports the form as it now
stands rather than only the fields that call happened to write. Without a `schema` the fields are the
registered names, every one of them a string, so a form of numbers or checkboxes
wants a schema: any Standard Schema value — zod, valibot, arktype — and, when
the library cannot describe itself as JSON Schema, a `parameters` next to it in
the `formTool` call.

**Nested values are written by path.** `setValue` takes a dotted path, so a call
of `{ meta: { subject: "…" } }` writes `meta.subject` rather than `meta`, and the
siblings under `meta` survive. An array is a leaf: it is what `useFieldArray`
holds, and writing one means replacing it. So is anything carrying a prototype of
its own, a `Date` or a `File` among them. `fieldsOf` only sees the top-level
keys, so without a `schema` a nested form advertises `meta` to the model as a
string field, not an object — a nested form wants a schema too.

The form is typed structurally — the `setValue`, `trigger`, `getValues` and
`formState` a `UseFormReturn` carries — so this package imports nothing from
react-hook-form at runtime; the peer states the range that shape was written
against.
