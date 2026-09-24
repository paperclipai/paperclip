Feature: Move and delete tasks from collection context menus

  Scenario: CM-1 Move a task from either collection
    Given a task is visible in the list or kanban board
    When I right-click the task and select a different status
    Then the existing update API changes only that task
    And the collection refreshes without opening task details

  Scenario: CM-2 Confirm deletion
    Given a task context menu is open
    When I choose Delete task
    Then a confirmation names the task and warns that deletion cannot be undone
    When I cancel
    Then no delete request is sent
    When I reopen and confirm deletion
    Then the existing delete API removes the task and the collection refreshes

  Scenario: CM-3 Handle failure
    Given the server rejects a move or delete
    Then an actionable error is visible
    And the task remains in the collection
    And I can retry or dismiss the error

  Scenario: CM-4 Preserve ordinary interaction
    Given the context menu is closed
    Then left-click still opens the task and kanban dragging still changes status
    When I open the context menu with the keyboard
    Then I can select actions with arrow keys and close with Escape

  Scenario: CM-5 Avoid duplicate actions
    Given an action is pending
    Then further mutations for this menu are disabled
    And the current status cannot trigger a redundant update

  Scenario: CM-6 Refresh compact collections after a confirmed mutation
    Given compact task lists for two companies are cached
    When I move or delete a task in one company
    Then its next compact list reflects the change immediately
    And the other company's cache is preserved
    And an older in-flight list cannot repopulate the invalidated cache
