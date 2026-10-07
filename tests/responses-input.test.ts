import test from "node:test";
import assert from "node:assert/strict";
import {
  inlineFileBytes,
  responsesBodyLimit,
  validateResponsesInput,
} from "../src/responsesInput.js";

function files(...data: string[]) {
  return {
    input: [
      {
        role: "user",
        content: data.map((file_data) => ({
          type: "input_file",
          filename: "test.docx",
          file_data,
        })),
      },
    ],
  };
}

test("counts raw and MIME-prefixed Base64 without decoding, including padding", () => {
  for (const size of [1, 2, 3, 4, 1001]) {
    const encoded = Buffer.alloc(size, 255).toString("base64");
    assert.equal(inlineFileBytes(encoded), size);
    assert.equal(inlineFileBytes(encoded.replace(/=+$/, "")), size);
    assert.equal(
      inlineFileBytes(`data:application/vnd.ms-excel;base64,${encoded}`),
      size,
    );
  }
});

test("rejects malformed Base64, noncanonical padding and malformed data URLs", () => {
  for (const data of [
    "",
    "=",
    "====",
    "A",
    "AA=",
    "AA===",
    "A===",
    "A AA",
    "AA_A",
    "AB==",
    "AAB=",
    "AA=A",
    "data:;base64,AA==",
    "data:application/pdf,AA==",
    "data:application/pdf;base64,",
  ]) {
    assert.throws(() => inlineFileBytes(data), { status: 400 });
  }
});

test("applies individual and aggregate decoded limits with exact boundaries", () => {
  const encode = (n: number) => Buffer.alloc(n).toString("base64");
  assert.equal(validateResponsesInput(files(encode(9)), 10), true);
  assert.throws(() => validateResponsesInput(files(encode(10)), 10), {
    status: 413,
  });
  assert.equal(validateResponsesInput(files(encode(5), encode(5)), 10), true);
  assert.throws(() => validateResponsesInput(files(encode(6), encode(5)), 10), {
    status: 413,
  });
});

test("validates inline parts without interpreting file contents or blocking other input types", () => {
  assert.equal(validateResponsesInput({ input: "Hello" }), false);
  assert.equal(
    validateResponsesInput({
      input: [
        {
          content: [
            { type: "input_file", file_id: "file_1" },
            { type: "input_file", file_url: "https://example.org/a.pdf" },
          ],
        },
      ],
    }),
    false,
  );
  for (const part of [
    { type: "input_file", file_data: "AA==" },
    { type: "input_file", filename: " ", file_data: "AA==" },
    { type: "input_file", filename: "x", file_data: 5 },
    { type: "input_file", filename: "x", file_data: "AA==", file_id: "file_1" },
    { type: "input_file", filename: "x" },
  ]) {
    assert.throws(
      () => validateResponsesInput({ input: [{ content: [part] }] }),
      { status: 400 },
    );
  }
  assert.throws(() => validateResponsesInput({ stream: "false" }), {
    status: 400,
  });
});

test("body limit defaults safely and accepts only positive safe integers", () => {
  assert.equal(responsesBodyLimit({}), 70_000_000);
  for (const value of [
    "0",
    "-1",
    "NaN",
    "Infinity",
    "1.5",
    "9007199254740992",
  ]) {
    assert.equal(
      responsesBodyLimit({ OPENAI_PROXY_RESPONSES_MAX_BODY_BYTES: value }),
      70_000_000,
    );
  }
  assert.equal(
    responsesBodyLimit({ OPENAI_PROXY_RESPONSES_MAX_BODY_BYTES: "4096" }),
    4096,
  );
});

const locations = [
  "message",
  "function_call_output",
  "custom_tool_call_output",
  "prompt",
];
function atLocations(entries: Array<[string, Record<string, unknown>]>) {
  const input: unknown[] = [];
  const variables: Record<string, unknown> = {};
  for (const [location, part] of entries) {
    if (location === "prompt")
      variables[`file${Object.keys(variables).length}`] = part;
    else if (location === "message")
      input.push({ role: "user", content: [part] });
    else input.push({ type: location, call_id: "call_test", output: [part] });
  }
  return {
    ...(input.length ? { input } : {}),
    prompt: { id: "pmpt_test", variables },
  };
}

for (const location of locations) {
  test(`validates files and detects inline data in ${location}`, () => {
    const part = {
      type: "input_file",
      filename: "report.docx",
      file_data: "AA==",
    };
    assert.equal(validateResponsesInput(atLocations([[location, part]])), true);
    for (const invalid of [
      { ...part, file_data: "invalid!" },
      { ...part, filename: "" },
      { ...part, file_id: "file_test" },
    ])
      assert.throws(
        () => validateResponsesInput(atLocations([[location, invalid]])),
        { status: 400 },
      );
    assert.throws(
      () =>
        validateResponsesInput(
          atLocations([
            [
              location,
              { ...part, file_data: Buffer.alloc(10).toString("base64") },
            ],
          ]),
          10,
        ),
      { status: 413 },
    );
  });
}

test("all supported locations share one decoded size budget, including mixed inputs", () => {
  const part = (size: number) => ({
    type: "input_file",
    filename: "a.xls",
    file_data: Buffer.alloc(size).toString("base64"),
  });
  // Scale the 26 MB + 26 MB regression down; exercise the same aggregate branch.
  for (const first of locations)
    for (const second of locations) {
      assert.throws(
        () =>
          validateResponsesInput(
            atLocations([
              [first, part(26)],
              [second, part(26)],
            ]),
            50,
          ),
        { status: 413 },
      );
      assert.equal(
        validateResponsesInput(
          atLocations([
            [first, part(25)],
            [second, part(25)],
          ]),
          50,
        ),
        true,
      );
    }
});

test("prompt-only inputs are checked even when input is a string; other tool data stays opaque", () => {
  assert.equal(
    validateResponsesInput({
      input: "Summarize",
      prompt: {
        id: "pmpt_test",
        variables: {
          document: {
            type: "input_file",
            filename: "a.doc",
            file_data: "AA==",
          },
        },
      },
    }),
    true,
  );
  assert.equal(
    validateResponsesInput({
      input: [
        {
          type: "function_call_output",
          output: '{"type":"input_file","file_data":"invalid"}',
        },
        { type: "custom_tool_call_output", output: "plain text" },
        { type: "function_call", arguments: '{"type":"input_file"}' },
      ],
      prompt: {
        id: "pmpt_test",
        variables: {
          text: "Hello",
          image: {
            type: "input_image",
            image_url: "https://example.org/a.png",
          },
        },
      },
      metadata: { type: "input_file", file_data: "invalid" },
    }),
    false,
  );
});
