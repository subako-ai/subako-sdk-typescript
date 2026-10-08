# @subako-ai/tools

Tools that let a Subako agent drive the page the person is already on:
`formTool` fills a form, `submitTool` sends one, `navigateTool` goes to a route,
and `fromFormElement` reads an existing form the way autofill does. Each tool is a function that
answers with the SDK's `ToolDefinition`, so it is declared through whatever
serves tools — `useTool` in `@subako-ai/react`, or `client.addTool` on the SDK's
own client.

Nothing here depends on a framework. The library adapters are their own
packages — `@subako-ai/tanstack-router`, `@subako-ai/react-hook-form` — and each
answers with the spec its tool takes, so a spread is all an app writes:

```ts
navigateTool(fromTanStackRouter(router));
formTool({ ...fromReactHookForm(form), description: "The contact form." });
```

Requires **Node 22 or newer** for the build. The package is **ESM only**.

```sh
pnpm add @subako-ai/tools @subako-ai/sdk
```

## `formTool`

```ts
formTool({
	description: "The contact form.",
	fields: {
		email: { type: "string", label: "Email address", required: true },
		plan: { type: "string", options: ["basic", "pro"] },
		newsletter: { type: "boolean" },
	},
	apply: (values) => form.reset({ ...form.getValues(), ...values }),
	read: () => ({ values: form.getValues() }),
});
```

Describe the form with `fields`, with a Standard Schema (`schema`), or with a
JSON Schema of your own (`parameters`). `execute` validates the arguments
against that description, calls `apply`, and answers with `read()` as JSON text
— or with the applied values when there is no `read` — so the model sees what it
actually wrote and can correct itself.

`apply` resolves once the values are in place, and `execute` awaits it before it
calls `read`. An adapter whose `apply` and `read` share one synchronous store —
`fromReactHookForm`, and any form library that keeps the values itself — needs
nothing more. An `apply` that sets React state under a `read` of the DOM does:
the DOM only carries the values once React has committed, so that `apply` has to
commit before it returns. `fromFormElement` below is that case.

- **`fields`** is the light DSL: `type` (`"string" | "number" | "boolean"`),
  `label`, `required`, and `options`. Every property of the derived schema is
  optional, so a partial fill is a valid call; `required` and the options are
  listed in the description instead.
- **`schema`** is any Standard Schema value — zod, valibot, arktype. When the
  library implements the Standard Schema v1.1 JSON Schema hook, as zod 4 does,
  the parameters come from the schema itself. When it does not, pass
  `parameters` next to it (`z.toJSONSchema(schema)` is the zod spelling), and
  note that the schema is offered to the model exactly as written: make it
  partial if a partial fill should be valid.

An argument the form would refuse — an unknown field, the wrong type, an option
that is not on the list — is answered as an error and nothing is applied.

**Blanks mean "leave it alone."** A provider whose function calling is strict —
`openai_responses` among them — makes the model fill every property of the
schema, whatever `required` says. So a field the person never mentioned arrives
as `""`, and applying that would wipe what they had already typed. `formTool`
drops every blank before it validates, the description tells the model it may
leave a field blank, and a field with `options` carries `""` among them so an
enum can be declined too. Without that last part the model has no way to say
"not this one" and stops to ask the person instead.

The drop goes all the way down, which is where it matters most: a nested form
has the model filling `meta.message` blank as readily as `message`, and the
write is by leaf. An object left entirely blank is dropped whole rather than
written as `{}` — that would be the same clobber the leaf-by-leaf write exists
to avoid. An array is a value, not a level: replacing one whole is what writing
it means.

A single input is a form with one field; there is no separate helper.

## `navigateTool`

```ts
navigateTool({
	routes: [
		{ to: "/", description: "The dashboard" },
		{ to: "/contact", description: "The contact form" },
		{ to: "/users/$userId", params: { userId: "string" } },
	],
	navigate: (to, params) => router.navigate({ to, params }),
	read: () => ({ location: window.location.pathname }),
});
```

`routes` is the allowlist: `to` becomes an `enum`, so the model can only name a
destination the app declared, and an external URL is not a destination at all.
The path parameters of every route are described as one `params` object; the
chosen route's own parameters are checked when the call arrives, so naming the
wrong ones is answered as an error rather than navigating. A strict schema makes
the model fill that object whole, so a parameter the chosen route does not take
is ignored when it is blank and refused only when it carries a value. The answer is
`read()`, or `{ location: to }`.

## `submitTool`

```ts
submitTool({
	description: "Submit the contact form.",
	submit: async () => await send(), // false when the form refused it
	read: () => ({ values: form.getValues(), errors: errorsOf(form) }),
});
```

Sending a form is its own tool, so an app declares it only where the model may
send: a form the person alone submits simply has no submit tool, and the model
can see that it has none. It takes no arguments, which is what stops a strict
schema from inventing one.

`submit` answers `false` when the form refused it — its own validation, most
often — and the tool then reads the form and reports what it was unhappy about,
so the model can fix the fields it named and submit again. Anything else counts
as sent. `read` is consulted **only** on a refusal: a form that went through may
have unmounted, and reading it then would be reading a ghost.

The demo's add-todo modal is this tool beside a `formTool`:
`testbed/demo/src/components/add-todo-modal.tsx`.

## `fromFormElement`

`fromFormElement` is a **reader**, the way browser autofill reads a form: the
controls' `name`, `type`, `<label>`, `required` and `<option>`s describe it, and
`read` reports the current values with whatever the browser's own validation is
unhappy with. Hidden, submit, button and password controls are left out. It
provides no `apply` — writing to a form is the app's — so pass one next to it:

```ts
formTool({ ...fromFormElement(formRef), apply: (values) => fill(values) });
```

Where that `apply` sets React state, it has to commit before it returns, because
`read` goes to the DOM and React would otherwise not have written it yet:

```ts
apply: (values) => flushSync(() => setSettings(values)),
```

The demo's settings page is that form, down to the `flushSync`:
`testbed/demo/src/routes/settings.tsx`.

The fields are a live reading: they answer from whatever the ref holds when they
are asked for, and `formTool` derives its schema when the client reads it. So a
component builds its tool while rendering, before the form has reached the DOM,
and the declaration that goes out carries the mounted form.
