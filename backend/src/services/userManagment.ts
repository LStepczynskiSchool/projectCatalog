import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  UpdateItemCommandInput,
  DeleteItemCommand,
  ReturnValue,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall, marshall } from '@aws-sdk/util-dynamodb';

import bcrypt from 'bcryptjs';
import { Helper } from './helper';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { S3 } from './s3';
import { v4 as uuidv4 } from 'uuid';
import { Email } from './Email';
import { Articles } from './articles';

import { client } from './dynamodb';
import { Tokens } from './tokens';

dotenv.config();

interface UserObject {
  Username: string;
  Password: string;
  Email: string;
  Admin: string;
  CanPost: string;
  Verified: string;
  LastPasswordChange: number;
  LastEmailChange: number;
  Liked: string[];
  ProfilePic: string;
  ProfilePicChange: any;
  AccountCreated: number;
}

interface ApiResponse {
  status: number;
  response: {
    [key: string]: any;
  };
}

export class UserManagment {
  public static profilePicCooldown = 7 * 24 * 60 * 60; // 1 week

  /**
   * Checks if an email is valid using regex
   *
   * @public
   * @static
   * @param {string} email
   * @returns {boolean}
   */
  public static isValidEmail(email: string) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  public static randomBytesHex(length: number) {
    const buffer = new Uint8Array(length);

    // Fill the buffer with random values
    for (let i = 0; i < length; i++) {
      buffer[i] = Math.floor(Math.random() * 256);
    }

    // Convert buffer to a hexadecimal string
    const hexString = Array.from(buffer)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

    return hexString;
  }

  /**
   * Checks if the username matches the one in the user object or if the user is an admin
   *
   * @public
   * @static
   * @param {string} username
   * @param {dict} user - user object
   * @returns {boolean}
   */
  public static checkUsername(username: string, user: any) {
    if (user.Admin === 'true') return true;
    if (user.Username === username) return true;
    return false;
  }

  /**
   * Checks if an user is an admin
   *
   * @public
   * @static
   * @param {UserObject} user - user object
   * @returns {boolean}
   */
  public static checkAdmin(user: any) {
    if (user.Admin === 'true') return true;
    return false;
  }

  /**
   * Checks if an user has the permision to post articles
   *
   * @public
   * @static
   * @param {UserObject} user - user object
   * @returns {boolean}
   */
  public static checkCanPost(user: any) {
    if (user.Admin === 'true') return true;
    if (user.CanPost === 'true') return true;
    return false;
  }

  /**
   * Decodes the object from a JWT
   *
   * @public
   * @static
   * @param {string} token - JWT
   * @returns {*} object
   */
  public static decodeJWT(token: string) {
    const base64Url = token.split('.')[1]; // Get the payload part
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        })
        .join('')
    );

    return JSON.parse(jsonPayload);
  }

  /**
   * Creates a new access JWT from an user object
   *
   * @public
   * @static
   * @param {UserObject} user
   * @returns {string}
   */
  public static getAccessJWT(user: any) {
    return jwt.sign(user, process.env.JWT_KEY || 'default', {
      expiresIn: '30m',
    });
  }

  /**
   * Creates a new refresh JWT from an user object
   *
   * @public
   * @static
   * @param {UserObject} user
   * @returns {string}
   */
  public static getRefreshJWT(user: any) {
    return jwt.sign(user, process.env.JWT_REFRESH_KEY || 'default', {
      expiresIn: '3d',
    });
  }

  /**
   * Hashes a password and returns it
   *
   * @public
   * @static
   * @async
   * @param {string} password
   * @returns {string}
   */
  public static async genPassHash(password: string) {
    const salt = await bcrypt.genSalt();
    return await bcrypt.hash(password, salt);
  }

  /**
   * Compares a password with a password hash
   *
   * @public
   * @static
   * @async
   * @param {string} password
   * @param {string} hash
   * @returns {boolean}
   */
  public static async compareHash(password: string, hash: string) {
    return await bcrypt.compare(password, hash);
  }

  /**
   * Checks if the provided timestamp is older than the cooldown value
   *
   * @public
   * @static
   * @param {*} timestamp
   * @returns {boolean}
   */
  public static checkProfilePictureCooldown(timestamp: any) {
    const currentTime = Helper.getUNIXTimestamp();
    if (
      timestamp != 'null' &&
      currentTime - timestamp < this.profilePicCooldown
    ) {
      return false;
    }
    return true;
  }

  /**
   * Creates an user object, adds it to the database, and returns the api response
   *
   * @public
   * @static
   * @async
   * @param {string} username
   * @param {string} password
   * @param {string} email
   * @param {string} [canPost='false']
   * @param {string} [admin='false']
   * @returns {unknown}
   */
  public static async createUser(
    username: string,
    password: string,
    email: string,
    canPost: string = 'true',
    admin: string = 'false'
  ) {
    // Validate the parameters
    if (!this.isValidEmail(email)) {
      return {
        status: 400,
        response: { message: 'invalid email address' },
      };
    }

    if (password.length < 8) {
      return {
        status: 400,
        response: { message: 'password must be at least 8 characters long' },
      };
    }

    if ((await this.getUser(username)) != null) {
      return {
        status: 400,
        response: { message: 'username is already in use' },
      };
    }

    // Hash the password
    password = await this.genPassHash(password);

    // Create the user object without the VerificationCode
    const userObject: UserObject = {
      Username: username,
      Password: password,
      Email: email,
      Admin: admin,
      Liked: [],
      CanPost: canPost,
      ProfilePic:
        'https://project-catalog-storage.s3.us-east-2.amazonaws.com/images/pfp.png',
      ProfilePicChange: 'null',
      AccountCreated: Helper.getUNIXTimestamp(),
      Verified: 'false',
      LastPasswordChange: Helper.getUNIXTimestamp(),
      LastEmailChange: Helper.getUNIXTimestamp(),
    };

    // Add the user object to the database
    const params: any = {
      TableName: 'Users',
      Item: marshall(userObject),
    };

    try {
      await client.send(new PutItemCommand(params));

      // Generate a verification code
      const verificationCode = this.randomBytesHex(24);

      // Create a token object
      const token = {
        username: username,
        value: verificationCode,
        type: 'email_verification',
        expiration: 0,
      };

      // Store the token using the Tokens class
      await Tokens.createToken(token);

      // Send verification email
      await Email.sendAccountVerificationEmail(
        email,
        username,
        verificationCode
      );

      return {
        status: 200,
        response: { message: 'user created successfully' },
      };
    } catch (err) {
      console.log(err);
      return {
        status: 500,
        response: { message: 'server error' },
      };
    }
  }

  /**
   * Deletes a user from the database and returns a response
   *
   * @public
   * @static
   * @async
   * @param {string} username
   * @returns {unknown}
   */
  public static async deleteUser(username: string) {
    const params = {
      TableName: 'Users',
      Key: {
        Username: { S: username },
      },
      ReturnValues: ReturnValue.ALL_OLD,
    };

    try {
      const response = await client.send(new DeleteItemCommand(params));

      if (!response.Attributes) {
        return { status: 404, response: { message: 'account not found' } };
      }
      return {
        status: 200,
        response: { message: 'account deleted succesfuly' },
      };
    } catch (err) {
      console.log(err);
      return { status: 500, response: { message: 'server error' } };
    }
  }

  /**
   * Fetches a user object from the database and returns it. Otherwise returns null
   *
   * @public
   * @static
   * @async
   * @param {string} username
   * @returns {unknown}
   */
  public static async getUser(username: string) {
    const params: any = {
      TableName: 'Users',
      Key: {
        Username: { S: username },
      },
    };

    try {
      const result = await client.send(new GetItemCommand(params));
      if (result.Item) {
        return unmarshall(result.Item);
      }
      return null;
    } catch (err) {
      console.log(err);
      return null;
    }
  }

  /**
   * Checks if an article is in the user's liked list
   *
   * @public
   * @static
   * @async
   * @param {string} username
   * @param {string} articleId
   * @returns {unknown}
   */
  public static async isLikedByUser(username: string, articleId: string) {
    const user = await this.getUser(username);
    if (!user) {
      return false;
    }
    if (user.Liked.includes(articleId)) {
      return true;
    }
    return false;
  }

  /**
   * Updates the user object in the database and returns an api response
   *
   * @public
   * @static
   * @async
   * @param {string} username
   * @param {string} fieldName
   * @param {*} fieldValue
   * @returns {unknown}
   */
  public static async updateUser(
    username: string,
    fieldName: string,
    fieldValue: any
  ) {
    const allowedFields = [
      'Email',
      'Password',
      'ProfilePic',
      'ProfilePicChange',
      'CanPost',
      'Admin',
      'Liked',
      'Verified',
      'LastPasswordChange',
      'LastEmailChange',
    ];

    // Check for dissallowed fields
    if (!allowedFields.includes(fieldName)) {
      return {
        status: 400,
        response: { message: 'Disallowed field' },
      };
    }

    // Dynamically determine the DynamoDB attribute type
    let dynamoValue;
    if (typeof fieldValue === 'string') {
      dynamoValue = { S: fieldValue };
    } else if (typeof fieldValue === 'number') {
      dynamoValue = { N: fieldValue.toString() };
    } else if (typeof fieldValue === 'boolean') {
      dynamoValue = { BOOL: fieldValue };
    } else if (Array.isArray(fieldValue)) {
      dynamoValue = { L: fieldValue.map((item) => ({ S: item.toString() })) };
    } else if (fieldValue === null) {
      dynamoValue = { NULL: true };
    } else {
      return {
        status: 400,
        response: { message: 'Unsupported data type' },
      };
    }

    const params: UpdateItemCommandInput = {
      TableName: 'Users',
      Key: {
        Username: { S: username },
      },
      UpdateExpression: 'SET #field = :newVal',
      ExpressionAttributeNames: {
        '#field': fieldName,
      },
      ExpressionAttributeValues: {
        ':newVal': dynamoValue,
      },
      ReturnValues: 'ALL_OLD',
    };

    // Update the user and return a response
    try {
      const command = new UpdateItemCommand(params);
      const result = await client.send(command);

      if (!result.Attributes) {
        return {
          status: 404,
          response: { message: 'User not found' },
        };
      }

      return {
        status: 200,
        response: { message: 'Item updated successfully' },
      };
    } catch (err) {
      console.error('Error updating item:', err);
      return {
        status: 500,
        response: { message: 'Internal server error' },
      };
    }
  }

  /**
   * Authenticates the user with the username and password. Returns the user JWT object
   * and the api response
   *
   * @public
   * @static
   * @async
   * @param {string} username
   * @param {string} password
   * @returns {unknown}
   */
  public static async verifyUser(username: string, password: string) {
    const user = await this.getUser(username);
    if (user == null) {
      return {
        status: 401,
        response: { message: 'invalid login credentials' },
      };
    }

    // Check for valid login credentials
    const verified = await this.compareHash(password, user.Password);
    if (!verified) {
      return {
        status: 401,
        response: { message: 'invalid login credentials' },
      };
    }

    // Delete the sensitive information from the user object before
    // turning it into a JWT
    delete user.Password;
    delete user.Liked;
    delete user.VerificationCode;

    // Create the JWT and return it
    const token = this.getAccessJWT(user);
    const refresh = this.getRefreshJWT(user);
    return {
      status: 200,
      response: {
        accessToken: token,
        refreshToken: refresh,
        user: this.decodeJWT(token),
      },
    };
  }

  /**
   * Changes the user's password after verifying the old password.
   *
   * @public
   * @static
   * @async
   * @param {string} username - The username of the user.
   * @param {string} oldPassword - The current password of the user.
   * @param {string} newPassword - The new password to be set.
   * @returns {unknown} - API response indicating success or failure.
   */
  public static async changePassword(
    username: string,
    oldPassword: string,
    newPassword: string
  ) {
    // Fetch the user object
    const user = await this.getUser(username);
    if (!user) {
      return {
        status: 404,
        response: { message: 'User not found.' },
      };
    }

    // Verify if the old password matches
    const isPasswordValid = await this.compareHash(oldPassword, user.Password);
    if (!isPasswordValid) {
      return {
        status: 401,
        response: { message: 'The old password is invalid.' },
      };
    }

    // Validate the new password length
    if (newPassword.length < 8) {
      return {
        status: 400,
        response: {
          message: 'New password must be at least 8 characters long.',
        },
      };
    }

    // Hash the new password
    const hashedNewPassword = await this.genPassHash(newPassword);

    // Update the user's password in the database
    const updateResponse = await this.updateUser(
      username,
      'Password',
      hashedNewPassword
    );
    if (updateResponse.status !== 200) {
      return updateResponse;
    }

    // Optionally, you might want to update the LastPasswordChange timestamp
    const currentTimestamp = Helper.getUNIXTimestamp();
    const timestampUpdateResponse = await this.updateUser(
      username,
      'LastPasswordChange',
      currentTimestamp
    );
    if (timestampUpdateResponse.status !== 200) {
      return timestampUpdateResponse;
    }

    return {
      status: 200,
      response: { message: 'Password changed successfully.' },
    };
  }

  /**
   * Changes the user's profile picture
   *
   * @public
   * @static
   * @async
   * @param {string} username
   * @param {file} file - profile picture image
   * @returns {unknown} - api response
   */
  public static async changeProfilePic(username: string, file: any) {
    // Fetch the user
    let user = await UserManagment.getUser(username);
    if (!user) {
      return { status: 404, response: { message: 'user not found' } };
    }

    // Check if the cooldown for changing the profile picture has passed
    const timestamp = Helper.getUNIXTimestamp();
    if (!this.checkProfilePictureCooldown(user.ProfilePicChange)) {
      return {
        status: 403,
        response: {
          message: 'the user profile picture was changed in the last week',
        },
      };
    }

    // Edit the ProfilePicChange property of the user object
    const userEditRes = await this.updateUser(
      user.Username,
      'ProfilePicChange',
      timestamp
    );
    if (userEditRes.status != 200) {
      return userEditRes;
    }
    user.ProfilePicChange = timestamp;

    // Get the old user profile picture and delete it
    const oldImageId = user.ProfilePic.match(
      /images\/([a-f0-9-]+)\.(?:png|jpg|jpeg|gif)$/
    );
    if (oldImageId) {
      await S3.removeImageFromS3(oldImageId[1]);
    }

    // Create the url for the new picture
    const imageId = uuidv4();
    user.ProfilePic = `${process.env.AWS_S3_LINK}/images/${imageId}.png`;

    // Save the picture in the S3 in 350x350 format
    try {
      const response = await S3.saveImage(imageId, file, 350, 350);
      if (!response) {
        throw new Error('S3 error');
      }
    } catch (err) {
      console.log('Error: ', err);
      return {
        status: 500,
        response: { message: 'server error' },
      };
    }

    // Update the profile picture link on all of the user's articles
    if (user.Admin || user.CanPost) {
      // A function to get all of the user's articles from a table
      const queryArticles = async (tableName: string) => {
        const articleReq = await client.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: 'AuthorDifficulty',
            KeyConditionExpression: 'Author = :username',
            ExpressionAttributeValues: {
              ':username': { S: user.Username },
            },
            ProjectionExpression: 'ID',
          })
        );
        return articleReq.Items || [];
      };

      // A function to update all the user articles from a table
      const updateArticles = async (tableName: string, articles: any) => {
        return Promise.all(
          articles.map(async (item: any) => {
            const id = item.ID?.S;
            if (id) {
              await client.send(
                new UpdateItemCommand({
                  TableName: tableName,
                  Key: { ID: { S: id } },
                  UpdateExpression: 'SET AuthorProfilePic = :newLink',
                  ExpressionAttributeValues: {
                    ':newLink': { S: user.ProfilePic },
                  },
                })
              );
            }
          })
        );
      };

      // Get user's articles
      const [privateArticles, publicArticles] = await Promise.all([
        queryArticles('ArticlesUnpublished'),
        queryArticles('ArticlesPublished'),
      ]);

      // Update user's articles
      await Promise.all([
        updateArticles('ArticlesUnpublished', privateArticles),
        updateArticles('ArticlesPublished', publicArticles),
      ]);
    }

    // Update the user's profile picture link
    const result = await UserManagment.updateUser(
      username,
      'ProfilePic',
      user.ProfilePic
    );
    // Modify the response from the updateUser function by adding in the new JWT
    // Token and return it
    const resultWithToken: any = result;
    delete user.Password;
    delete user.Liked;
    delete user.VerificationCode;

    resultWithToken.response.verificationToken =
      UserManagment.getAccessJWT(user);
    resultWithToken.response.user = user;
    return resultWithToken;
  }

  public static async verifyEmail(verificationCode: string) {
    try {
      // Retrieve the token using the Tokens class
      const token = await Tokens.getToken(verificationCode);

      if (token && token.type === 'email_verification') {
        const username = token.username;

        // Get the user associated with the token
        const user = await this.getUser(username);

        if (user) {
          if (user.Verified === 'false') {
            // Update the user's Verified status
            const updateRes = await this.updateUser(
              username,
              'Verified',
              'true'
            );

            if (updateRes.status == 200) {
              // Delete the token after successful verification
              await Tokens.deleteToken(verificationCode);

              return { status: 200, response: { message: 'email verified' } };
            } else {
              throw new Error('Unable to update user verification status');
            }
          } else {
            return {
              status: 410,
              response: { message: 'account already verified' },
            };
          }
        } else {
          return { status: 404, response: { message: 'user not found' } };
        }
      } else {
        return {
          status: 404,
          response: { message: 'invalid or expired verification code' },
        };
      }
    } catch (err) {
      console.log(err);
      return { status: 500, response: { message: 'server error' } };
    }
  }

  public static async verifyEmailChange(token: string) {
    try {
      // Retrieve the token using the Tokens class
      const storedToken = await Tokens.getToken(token);

      if (
        !storedToken ||
        storedToken.type !== 'email_change' ||
        storedToken.expiration < Math.floor(Date.now() / 1000)
      ) {
        return {
          status: 410,
          response: {
            message: 'Verification token is invalid or has expired.',
          },
        };
      }

      const username = storedToken.username;
      const newEmail = storedToken.newEmail; // Extract the new email from the token

      // Get the user associated with the token
      const user = await this.getUser(username);

      if (!user) {
        return {
          status: 404,
          response: { message: 'User not found.' },
        };
      }

      // Update the user's email in the database
      const updateResponse = await this.updateUser(username, 'Email', newEmail);
      if (updateResponse.status !== 200) {
        return updateResponse;
      }

      // Delete the token after successful verification
      await Tokens.deleteToken(token);

      return {
        status: 200,
        response: { message: 'Email address successfully updated.' },
      };
    } catch (err) {
      console.error('Error in verifyEmailChange:', err);
      return {
        status: 500,
        response: { message: 'Server error. Please try again later.' },
      };
    }
  }

  public static async requestEmailChange(
    username: string,
    password: string,
    newEmail: string
  ) {
    try {
      const currentTime = Helper.getUNIXTimestamp();

      const user = await this.getUser(username);
      if (!user) {
        return {
          status: 404,
          response: { message: 'User not found.' },
        };
      }

      if (user.LastEmailChange + 3 * 60 * 60 > currentTime) {
        return {
          status: 429,
          response: {
            message:
              'you have requested an email change recently. Please try again later.',
          },
        };
      }

      const isPasswordValid = await this.compareHash(password, user.Password);
      if (!isPasswordValid) {
        return {
          status: 401,
          response: { message: 'Invalid password.' },
        };
      }

      const verificationTokenValue = this.randomBytesHex(24);
      const token = {
        username: username,
        value: verificationTokenValue,
        type: 'email_change',
        newEmail: newEmail,
        expiration: Math.floor(Date.now() / 1000) + 6 * 3600, // Token expires in 6 hours
      };

      await Tokens.createToken(token);
      await Email.sendEmailChangeVerificationEmail(
        newEmail,
        username,
        verificationTokenValue
      );

      await this.updateUser(user.Username, 'LastEmailChange', currentTime);

      user.LastPasswordChange = currentTime;

      const verificationToken = this.getAccessJWT(user);
      return {
        status: 200,
        response: {
          message: 'Verification email sent to new email address.',
          accessToken: verificationToken,
          user: this.decodeJWT(verificationToken),
        },
      };
    } catch (err) {
      console.error('Error in requestEmailChange:', err);
      return {
        status: 500,
        response: { message: 'Server error. Please try again later.' },
      };
    }
  }

  public static async sendPasswordResetEmail(username: string) {
    const currentTime = Helper.getUNIXTimestamp();

    // Get the user by username
    const user = await this.getUser(username);
    if (!user) {
      return {
        status: 404,
        response: { message: 'user not found' },
      };
    }

    // Check if user is verified
    if (user.Verified !== 'true') {
      return {
        status: 403,
        response: { message: 'user is not verified' },
      };
    }

    if (user.LastPasswordChange + 60 * 15 > currentTime) {
      return {
        status: 429,
        response: {
          message:
            'you have requested a password reset recently. Please try again later.',
        },
      };
    }

    // Generate a password reset token
    const resetTokenValue = this.randomBytesHex(24);

    // Create a token object
    const resetToken = {
      username: username,
      value: resetTokenValue,
      type: 'password_reset',
      expiration: currentTime + 6 * 3600,
    };

    // Store the token using the Tokens class
    await Tokens.createToken(resetToken);

    // Send password reset email
    await Email.sendPasswordResetEmail(user.Email, username, resetTokenValue);

    await this.updateUser(user.Username, 'LastPasswordChange', currentTime);

    user.LastPasswordChange = currentTime;

    const verificationToken = this.getAccessJWT(user);

    return {
      status: 200,
      response: {
        message: 'password reset email sent.',
        accessToken: verificationToken,
        user: this.decodeJWT(verificationToken),
      },
    };
  }

  public static async resetPassword(verificationCode: string) {
    try {
      // Retrieve the token using the Tokens class
      const token = await Tokens.getToken(verificationCode);

      if (token && token.type === 'password_reset') {
        const currentTimestamp = Helper.getUNIXTimestamp();

        // Check if the token has expired
        if (token.expiration < currentTimestamp) {
          // Token has expired, delete it
          await Tokens.deleteToken(verificationCode);
          return {
            status: 410,
            response: {
              message:
                'Verification code has expired. Please request a new password reset.',
            },
          };
        }

        const username = token.username;

        // Get the user associated with the token
        const user = await this.getUser(username);

        if (user) {
          // Generate a new password: username + 8 random characters
          const newPassword = username + this.randomBytesHex(8);

          // Hash the new password
          const hashedPassword = await this.genPassHash(newPassword);

          // Update the user's password
          const updateRes = await this.updateUser(
            username,
            'Password',
            hashedPassword
          );

          if (updateRes.status === 200) {
            // Delete the token after successful password reset
            await Tokens.deleteToken(verificationCode);

            // Send email to user with the new password
            const emailSent = await Email.sendNewPasswordEmail(
              user.Email,
              username,
              newPassword
            );
            if (!emailSent) {
              console.warn(
                `Failed to send new password email to ${user.Email}`
              );
            }

            return {
              status: 200,
              response: {
                message:
                  'Password reset successful. Please check your email for the new password.',
              },
            };
          } else {
            throw new Error('Unable to update user password.');
          }
        } else {
          return {
            status: 404,
            response: { message: 'User not found.' },
          };
        }
      } else {
        return {
          status: 404,
          response: { message: 'Invalid or expired verification code.' },
        };
      }
    } catch (err) {
      console.error('Error in resetPassword:', err);
      return {
        status: 500,
        response: { message: 'Server error. Please try again later.' },
      };
    }
  }

  /**
   * Deletes a user account by first authenticating the user,
   * then removing all their articles, and finally deleting the user from the database.
   *
   * @public
   * @static
   * @async
   * @param {string} username - The username of the account to delete.
   * @param {string} password - The password of the user for authentication.
   * @returns {Promise<ApiResponse>} - API response indicating success or failure.
   */
  public static async deleteUserAccount(
    username: string,
    password: string
  ): Promise<ApiResponse> {
    try {
      // Step 1: Authenticate the user
      const user = await this.getUser(username);
      if (!user) {
        return {
          status: 404,
          response: { message: 'user not found.' },
        };
      }

      const verified = await this.compareHash(password, user.Password);

      if (!verified) {
        return {
          status: 403,
          response: { message: 'invalid password.' },
        };
      }

      // Step 2: Remove all user content
      const id = user.ProfilePic.match(/images\/([^\/]+)\./)[1];

      if (id != 'pfp') {
        const removeProfilePicRes = await S3.removeImageFromS3(id);

        if (!removeProfilePicRes) {
          return {
            status: 500,
            response: { message: 'server error' },
          };
        }
      }

      const tokenResponse = await Tokens.deleteUserTokens(username);
      if (!tokenResponse) {
        return {
          status: 500,
          response: { message: 'server error' },
        };
      }

      const removeArticlesResponse = await Articles.removeAllArticlesByUser(
        username
      );

      if (removeArticlesResponse.status !== 200) {
        // Failed to delete articles; return the error response
        return removeArticlesResponse;
      }

      // Step 3: Delete the user account from the database
      const deleteUserResponse = await this.deleteUser(username);

      // Optionally, you can add additional steps here, such as logging the deletion or sending a confirmation email.

      // Return the response from deleting the user
      return deleteUserResponse;
    } catch (error: any) {
      console.error('Error deleting user account:', error);
      return {
        status: 500,
        response: { message: 'Server error while deleting user account.' },
      };
    }
  }

  public static authenticateToken(requireVerified: boolean = true) {
    return (req: any, res: any, next: any) => {
      const token = req.cookies.token;
      if (token == null) {
        return res.status(400).send({
          status: 400,
          response: { message: 'missing authentication token' },
        });
      }

      jwt.verify(
        token,
        process.env.JWT_KEY || 'default',
        (err: any, user: any) => {
          if (err) {
            if (err.name === 'TokenExpiredError') {
              return res.status(401).send({
                status: 401,
                response: { message: 'token expired' },
              });
            }
            return res.status(403).send({
              status: 403,
              response: { message: 'invalid token' },
            });
          }

          if (requireVerified && user.Verified == 'false') {
            return res.status(403).send({
              status: 403,
              response: { message: 'account not verified' },
            });
          }

          req.user = user;
          next();
        }
      );
    };
  }

  public static authTokenOptional(req: any, res: any, next: any) {
    const token = req.cookies.token;
    if (token == null) {
      req.user = {};
      next();
      return;
    }

    jwt.verify(
      token,
      process.env.JWT_KEY || 'default',
      (err: any, user: any) => {
        if (err) {
          if (err.name === 'TokenExpiredError') {
            return res.status(401).send({
              status: 401,
              response: { message: 'token expired' },
            });
          }
          return res.status(403).send({
            status: 403,
            response: { message: 'invalid token' },
          });
        }
        req.user = user;
        next();
      }
    );
  }
}
