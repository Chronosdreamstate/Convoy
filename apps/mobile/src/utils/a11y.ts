export const a11y = {
  heading: (_level: 1 | 2 | 3 = 1) => ({
    accessibilityRole: 'header' as const,
  }),

  image: (label: string) => ({
    accessible: true,
    accessibilityRole: 'image' as const,
    accessibilityLabel: label,
  }),

  hidden: () => ({
    accessible: false,
    importantForAccessibility: 'no-hide-descendants' as const,
  }),

  minTarget: {
    minWidth: 44,
    minHeight: 44,
  } as const,
};
