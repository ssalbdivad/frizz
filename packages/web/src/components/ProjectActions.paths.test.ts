import assert from "node:assert/strict"
import { test } from "node:test"
import { homeOf, shortPath } from "./ProjectActions.tsx"

// The Home workspace's folder is, by default, the home folder ITSELF — the one path the helpers had
// never been handed, because a project can never be registered there.
test("the home folder itself shortens to ~, and is found as the home when it heads the list", () => {
  assert.equal(shortPath("/home/x", "/home/x"), "~")
  assert.equal(shortPath("/home/x/code", "/home/x"), "~/code")
  assert.equal(shortPath("/home/xy", "/home/x"), "/home/xy", "a sibling that shares the prefix is not under home")
  assert.equal(homeOf([{ path: "/home/x" }]), "/home/x")
  assert.equal(homeOf([{ path: "/Users/x/code/app" }]), "/Users/x")
  assert.equal(homeOf([{ path: "/srv/app" }]), undefined)
})
