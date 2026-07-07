import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { ActivityIndicator, Text } from 'react-native';
import AsyncListState from './AsyncListState';

function render(ui: React.ReactElement): ReactTestInstance {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  act(() => {
    renderer = TestRenderer.create(ui);
  });
  return renderer.root;
}

/** True if any node in the tree has exactly this string as its children. */
function hasText(root: ReactTestInstance, text: string): boolean {
  return root.findAll((n) => n.props?.children === text).length > 0;
}

const baseProps = {
  loading: false,
  error: null,
  isEmpty: false,
  onRetry: () => {},
};

describe('AsyncListState', () => {
  it('renders the loading spinner while loading', () => {
    const root = render(
      <AsyncListState {...baseProps} loading>
        <Text>content</Text>
      </AsyncListState>,
    );

    expect(root.findAllByType(ActivityIndicator)).toHaveLength(1);
    // Announced to screen readers as a progress indicator. RN forwards
    // accessibilityRole through multiple nested host/composite layers, so
    // assert presence rather than an exact node count.
    expect(root.findAll((n) => n.props?.accessibilityRole === 'progressbar').length).toBeGreaterThan(0);
    // Loaded content is not shown yet.
    expect(hasText(root, 'content')).toBe(false);
  });

  it('renders the error state with a working Retry button', () => {
    const onRetry = jest.fn();
    const root = render(
      <AsyncListState {...baseProps} error={new Error('boom')} onRetry={onRetry}>
        <Text>content</Text>
      </AsyncListState>,
    );

    expect(hasText(root, 'Something went wrong')).toBe(true);

    const button = root.find((n) => n.props?.accessibilityRole === 'button');
    expect(button.props.accessibilityLabel).toBe('Try again');

    act(() => {
      button.props.onPress();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the error state (not a false-empty) when error and isEmpty are both set', () => {
    // This is the whole reason the component exists: a failed load must never
    // silently render as an empty state.
    const root = render(
      <AsyncListState {...baseProps} error={new Error('boom')} isEmpty emptyTitle="No items">
        <Text>content</Text>
      </AsyncListState>,
    );

    expect(hasText(root, 'Something went wrong')).toBe(true);
    expect(hasText(root, 'No items')).toBe(false);
    // Same nested-layer forwarding as above — assert presence, not count.
    expect(root.findAll((n) => n.props?.accessibilityRole === 'button').length).toBeGreaterThan(0);
  });

  it('renders the empty state when loaded with no data', () => {
    const root = render(
      <AsyncListState
        {...baseProps}
        isEmpty
        emptyTitle="No groups yet"
        emptyMessage="Join or create a group to get rolling."
      >
        <Text>content</Text>
      </AsyncListState>,
    );

    expect(hasText(root, 'No groups yet')).toBe(true);
    expect(hasText(root, 'Join or create a group to get rolling.')).toBe(true);
    // No retry affordance and no loaded content in the empty state.
    expect(root.findAll((n) => n.props?.accessibilityRole === 'button')).toHaveLength(0);
    expect(hasText(root, 'content')).toBe(false);
  });

  it('renders children when loaded with data', () => {
    const root = render(
      <AsyncListState {...baseProps}>
        <Text>content</Text>
      </AsyncListState>,
    );

    expect(hasText(root, 'content')).toBe(true);
    expect(root.findAllByType(ActivityIndicator)).toHaveLength(0);
    expect(root.findAll((n) => n.props?.accessibilityRole === 'button')).toHaveLength(0);
  });
});
