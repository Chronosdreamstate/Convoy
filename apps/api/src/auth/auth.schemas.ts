import { z } from 'zod';

/** E.164 phone number format: +[country code][number] */
const e164Regex = /^\+[1-9]\d{1,14}$/;

export const otpRequestSchema = z.object({
  phone: z.string().regex(e164Regex, 'Phone number must be in E.164 format (e.g. +15555550100)'),
});

export const otpVerifySchema = z.object({
  phone: z.string().regex(e164Regex, 'Phone number must be in E.164 format'),
  otp: z.string().length(6, 'OTP must be 6 digits'),
});

export const emailSignupSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const emailLoginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const socialAuthSchema = z.object({
  provider: z.enum(['apple', 'google']),
  idToken: z.string().min(1, 'idToken is required'),
});

export type OtpRequestInput = z.infer<typeof otpRequestSchema>;
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;
export type EmailSignupInput = z.infer<typeof emailSignupSchema>;
export type EmailLoginInput = z.infer<typeof emailLoginSchema>;
export type SocialAuthInput = z.infer<typeof socialAuthSchema>;
