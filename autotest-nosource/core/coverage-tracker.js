// Runtime coverage tracker for black-box Web testing.
(function (global) {
  "use strict";

  function uniqueKey(node) {
    return [node.selector || node.ref || "", node.role || node.tag || "", node.label || node.text || node.placeholder || ""].join("|");
  }

  function create() {
    var pages = {};
    var controls = {};
    var actions = [];
    var assertions = [];

    function observeSnapshot(snapshot) {
      snapshot = snapshot || {};
      var pageKey = snapshot.url || snapshot.title || "unknown";
      if (!pages[pageKey]) pages[pageKey] = { url: snapshot.url || "", title: snapshot.title || "", visits: 0, controls: {} };
      pages[pageKey].visits++;
      (snapshot.nodes || []).forEach(function (node) {
        var key = uniqueKey(node);
        if (!key || key === "||") return;
        var control = controls[pageKey + "|" + key] || {
          pageKey: pageKey,
          selector: node.selector || "",
          ref: node.ref || "",
          label: node.label || node.text || node.placeholder || node.name || node.role || node.tag || "",
          role: node.role || node.tag || "",
          observed: 0,
          exercised: 0,
        };
        control.observed++;
        controls[pageKey + "|" + key] = control;
        pages[pageKey].controls[pageKey + "|" + key] = true;
      });
    }

    function recordAction(action, args, snapshot, ok) {
      args = args || {};
      var pageKey = snapshot && (snapshot.url || snapshot.title) || "unknown";
      var selector = args.selector || "";
      if (!selector && args.elementRef && snapshot) {
        (snapshot.nodes || []).some(function (node) {
          if (node.ref === args.elementRef) { selector = node.selector || ""; return true; }
          return false;
        });
      }
      Object.keys(controls).forEach(function (key) {
        var control = controls[key];
        if (control.pageKey === pageKey && selector && control.selector === selector) control.exercised++;
      });
      actions.push({ action: action || "", selector: selector, pageKey: pageKey, ok: ok !== false });
      if (actions.length > 300) actions.shift();
    }

    function recordAssertion(assertion, testCaseId) {
      assertions.push({ passed: !!(assertion && assertion.passed), testCaseId: testCaseId || "" });
    }

    function summary(testCases) {
      var allControls = Object.keys(controls).map(function (key) { return controls[key]; });
      var exercised = allControls.filter(function (control) { return control.exercised > 0; });
      var cases = testCases || [];
      var completed = cases.filter(function (testCase) { return testCase.status === "passed" || testCase.status === "failed" || testCase.status === "skipped"; });
      return {
        pages: Object.keys(pages).map(function (key) { return pages[key]; }),
        observedPageCount: Object.keys(pages).length,
        observedControlCount: allControls.length,
        exercisedControlCount: exercised.length,
        controlCoverage: allControls.length ? Math.round(exercised.length / allControls.length * 100) : 0,
        actionCount: actions.length,
        successfulActionCount: actions.filter(function (action) { return action.ok; }).length,
        testCaseCount: cases.length,
        completedTestCaseCount: completed.length,
        pendingTestCaseCount: cases.length - completed.length,
        assertions: assertions.slice(),
      };
    }

    return { observeSnapshot: observeSnapshot, recordAction: recordAction, recordAssertion: recordAssertion, summary: summary };
  }

  global.AIFT_CoverageTracker = { create: create };
})(window);
